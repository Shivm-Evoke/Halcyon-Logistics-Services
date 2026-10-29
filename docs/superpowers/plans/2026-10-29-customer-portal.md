# Customer Portal, Logins and Dispatch Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live Halcyon app work like a logistics company: public homepage, customer and staff sign-in, a customer portal that places and tracks orders through the existing gateway, and a staff Dispatch board that moves shipments through their stages.

**Architecture:** Pure server modules (sessions, access rules, stage machine, seeding, rate limit) take injected stores so `node:test` runs without a database, as the existing unit tests do; Postgres stores and Express routes wrap them and are covered end to end by Playwright. The web app gains a router split: public pages (`/`, `/login`), a customer layout (`/portal/*`) and the existing story app as the staff area.

**Tech Stack:** Node 22, Express 5, pg, `node:test`; React 19, react-router-dom, Vite; Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-customer-portal-design.md`

## Global Constraints

- Branch `feature/customer-portal`; commit locally, push only when the user asks. Pushing `main` deploys production.
- No passwords or keys in code, tests' committed files, chat or logs. Demo accounts come only from `DEMO_CUSTOMER_EMAIL`, `DEMO_CUSTOMER_PASSWORD`, `DEMO_CUSTOMER_CLIENT` (default `C055`), `DEMO_STAFF_EMAIL`, `DEMO_STAFF_PASSWORD`; unset seeds nothing.
- Session cookie `halcyon_session`: HttpOnly, SameSite=Lax, Secure when `NODE_ENV=production`, 8 hours, signed with `JWT_SECRET` via existing `signToken`/`verifyToken` (`server/src/ingest/auth.js`). Passwords hashed with existing `hashSecret`/`checkSecret`.
- Login failure: 401 `{ error: 'Wrong email or password' }` for both unknown email and wrong password. Limit: 10 attempts per email per 15 minutes → 429.
- Stages, in order: `received`, `picked`, `collected`, `in_transit`, `delivered`; side stages `on_hold`, `cancelled`. At-risk threshold: risk ≥ 0.4.
- `REQUIRE_LOGIN` defaults on (`'0'` turns the staff gate off). Public API: `/api/health`, `/api/session/*`, `/api/auth/*`, `/api/v1/*`, `/api/openapi.json`, `/api/docs`.
- Foreign order refs return 404, never 403. Match existing code style: comment density, `q`/`one` helpers, plain-language UI copy.

## Review Focus

- A customer session calling a staff API (e.g. `/api/agents/datasets`) must get 403, and a staff session calling `/api/portal/*` must get 403 — tested in Task 2.
- A tampered or expired cookie must act as signed out (401), not crash — Task 1.
- Seeding twice with a changed password must update the hash, and a customer env without a valid client must seed nothing with a warning — Task 3.
- Advancing a `delivered`, `cancelled` or `on_hold` order must be refused with 409 and leave no event — Task 4.
- Reloading `/portal/shipments/:ref` or `/start` directly must load the right layout (SPA fallback covers both) — Task 8 e2e.

---

### Task 1: Sessions and login rate limit

**Files:**
- Create: `server/src/auth/session.js`
- Test: `server/test/auth-session.test.js`

**Interfaces:**
- Produces: `SESSION_COOKIE = 'halcyon_session'`, `SESSION_TTL = 8 * 3600`; `issueSession(user, key) -> string` (token with `sub`=user id, `email`, `name`, `role`, `client_id`); `readSession(cookieHeader, key) -> {id,email,name,role,client_id} | null`; `sessionCookie(token, {secure}) -> string` and `clearCookie({secure}) -> string` (Set-Cookie values); `createRateLimiter({limit=10, windowMs=15*60*1000, now=Date.now}) -> { hit(email) -> boolean }` (false once the limit is exceeded; keyed case-insensitively).

- [ ] **Step 1: Write the failing tests**

```js
test('a session round-trips through the cookie and a tampered one reads as signed out', () => {
  const token = issueSession({ id: 7, email: 'a@x.com', name: 'Ann', role: 'customer', client_id: 'C055' }, 'k');
  assert.deepEqual(readSession(`x=1; ${SESSION_COOKIE}=${token}`, 'k'), { id: 7, email: 'a@x.com', name: 'Ann', role: 'customer', client_id: 'C055' });
  assert.equal(readSession(`${SESSION_COOKIE}=${token}x`, 'k'), null);
  assert.equal(readSession(`${SESSION_COOKIE}=${token}`, 'other'), null);
  assert.equal(readSession(undefined, 'k'), null);
});
test('the cookie is HttpOnly, Lax, 8 hours, and Secure only when asked', () => {
  assert.match(sessionCookie('t', { secure: false }), /^halcyon_session=t; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800$/);
  assert.match(sessionCookie('t', { secure: true }), /; Secure$/);
  assert.match(clearCookie({ secure: false }), /Max-Age=0/);
});
test('login attempts are limited per email per window', () => {
  let t = 0; const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(rl.hit('A@x.com'), true); assert.equal(rl.hit('a@x.com'), true); assert.equal(rl.hit('a@x.com'), false);
  t = 1001; assert.equal(rl.hit('a@x.com'), true);
});
```

- [ ] **Step 2: Run** `node --test server/test/auth-session.test.js` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `server/src/auth/session.js` with the interfaces above, reusing `signToken`/`verifyToken`.
- [ ] **Step 4: Run** the same command — Expected: 3 pass.
- [ ] **Step 5: Commit** `feat(auth): signed session cookie and login rate limit`.

### Task 2: Access rules

**Files:**
- Create: `server/src/auth/access.js`
- Test: `server/test/auth-access.test.js`

**Interfaces:**
- Consumes: `readSession` (Task 1).
- Produces: `accessFor(path, user, { requireLogin }) -> 'ok' | 401 | 403` (path is relative to `/api`, e.g. `/portal/orders`); `gate({ key, requireLogin }) -> express middleware` that sets `req.user` and answers 401/403 as `{ error: 'Sign in required' }` / `{ error: 'Not allowed' }`.

- [ ] **Step 1: Write the failing tests**

```js
const C = { role: 'customer', client_id: 'C055' }, S = { role: 'staff' };
test('public routes need no session', () => {
  for (const p of ['/health', '/session/login', '/session', '/auth/login', '/v1/orders', '/openapi.json', '/docs']) assert.equal(accessFor(p, null, { requireLogin: true }), 'ok');
});
test('portal is customers only and everything else is staff only', () => {
  assert.equal(accessFor('/portal/orders', null, { requireLogin: true }), 401);
  assert.equal(accessFor('/portal/orders', C, { requireLogin: true }), 'ok');
  assert.equal(accessFor('/portal/orders', S, { requireLogin: true }), 403);
  assert.equal(accessFor('/agents/datasets', C, { requireLogin: true }), 403);
  assert.equal(accessFor('/agents/datasets', S, { requireLogin: true }), 'ok');
  assert.equal(accessFor('/dispatch', null, { requireLogin: true }), 401);
});
test('with login switched off the staff area is open but the portal still needs a customer', () => {
  assert.equal(accessFor('/agents/datasets', null, { requireLogin: false }), 'ok');
  assert.equal(accessFor('/portal/orders', null, { requireLogin: false }), 401);
});
```

- [ ] **Step 2: Run** `node --test server/test/auth-access.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `accessFor` and `gate` in `server/src/auth/access.js`.
- [ ] **Step 4: Run** — Expected: 3 pass.
- [ ] **Step 5: Commit** `feat(auth): access rules for public, customer and staff routes`.

### Task 3: Users table, seeding and session routes

**Files:**
- Create: `server/src/auth/users.js` (Postgres store + `ensureUserTable`), `server/src/auth/seed.js`, `server/src/routes/session.js`
- Modify: `db/schema.sql` (add `users` and to the DROP list), `server/src/index.js` (await `ensureUserTable()` and `seedDemoUsers(...)` at startup; mount `gate` before all `/api` routers; mount session router), `server/.env.example` (add the five `DEMO_*` names with blank values, `DEMO_CUSTOMER_CLIENT=C055`)
- Test: `server/test/auth-seed.test.js`

**Interfaces:**
- Produces: `userStore = { byEmail(email) -> user|null, upsert({email,name,role,client_id,password_hash}) -> user, touch(id) }`; `ensureUserTable()`; `seedDemoUsers(env, { store, clientExists(id) -> Promise<boolean>, hash = hashSecret, log = console }) -> Promise<string[]>` (emails seeded); routes `POST /session/login`, `POST /session/logout`, `GET /session` per spec.

- [ ] **Step 1: Write the failing tests** (memory store passed in)

```js
test('unset variables seed nobody', async () => {
  assert.deepEqual(await seedDemoUsers({}, { store: memoryStore(), clientExists: async () => true }), []);
});
test('both demo accounts are seeded, emails lower-cased, and re-seeding replaces the hash', async () => {
  const store = memoryStore(); const env = { DEMO_CUSTOMER_EMAIL: 'Buyer@C055.test', DEMO_CUSTOMER_PASSWORD: 'p1', DEMO_STAFF_EMAIL: 'ops@halcyon.test', DEMO_STAFF_PASSWORD: 'p2' };
  assert.deepEqual(await seedDemoUsers(env, { store, clientExists: async () => true, hash: (s) => `h:${s}` }), ['buyer@c055.test', 'ops@halcyon.test']);
  assert.equal((await store.byEmail('buyer@c055.test')).client_id, 'C055');
  await seedDemoUsers({ ...env, DEMO_STAFF_PASSWORD: 'p3' }, { store, clientExists: async () => true, hash: (s) => `h:${s}` });
  assert.equal((await store.byEmail('ops@halcyon.test')).password_hash, 'h:p3');
});
test('a customer for an unknown client is skipped with a warning', async () => {
  const warned = []; const store = memoryStore();
  await seedDemoUsers({ DEMO_CUSTOMER_EMAIL: 'b@x.test', DEMO_CUSTOMER_PASSWORD: 'p', DEMO_CUSTOMER_CLIENT: 'C999' }, { store, clientExists: async () => false, log: { warn: (m) => warned.push(m) } });
  assert.equal(await store.byEmail('b@x.test'), null); assert.match(warned[0], /C999/);
});
```

(`memoryStore()` is a test helper in the same file implementing `byEmail`/`upsert`/`touch` over a Map.)

- [ ] **Step 2: Run** `node --test server/test/auth-seed.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `seed.js`, `users.js`, `routes/session.js` (login uses `createRateLimiter` and `checkSecret`; sets cookie with `secure: NODE_ENV==='production'`; login with no users at all returns 503 `{ error: 'Sign-in is not set up yet' }`), schema changes and startup wiring. Never log passwords or hashes.
- [ ] **Step 4: Run** `npm --prefix server test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(auth): users, demo seeding from env, session routes`.

### Task 4: Shipment stages

**Files:**
- Create: `server/src/shipments/stages.js`, `server/src/shipments/store.js` (Postgres: `ensureShipmentTable`, `addEvent`, `eventsFor(orderIds)`, `latestStage(orderId)`)
- Modify: `db/schema.sql` (add `shipment_events` and to the DROP list), `server/src/ingest/pipeline.js` (after an order row is saved or reprocessed, record its first event via `initialStage`), `server/src/index.js` (await `ensureShipmentTable()`)
- Test: `server/test/shipment-stages.test.js`

**Interfaces:**
- Produces: `STAGES = ['received','picked','collected','in_transit','delivered']`; `initialStage(orderStatus) -> 'received'|'on_hold'|'cancelled'` (`accepted`/`corrected` → received, `held` → on_hold, `rejected`/`duplicate` → cancelled); `nextStage(current) -> string | null` (null for `delivered`, `cancelled`, `on_hold`); `atRisk(risk) -> boolean` (≥ 0.4); `stageOf(events) -> string` (latest by `at`, then id).

- [ ] **Step 1: Write the failing tests**

```js
test('orders start in a stage that matches the gateway result', () => {
  assert.equal(initialStage('accepted'), 'received'); assert.equal(initialStage('corrected'), 'received');
  assert.equal(initialStage('held'), 'on_hold'); assert.equal(initialStage('rejected'), 'cancelled'); assert.equal(initialStage('duplicate'), 'cancelled');
});
test('stages only move one step forward and stop at the end, on hold or cancelled', () => {
  assert.equal(nextStage('received'), 'picked'); assert.equal(nextStage('in_transit'), 'delivered');
  for (const s of ['delivered', 'cancelled', 'on_hold']) assert.equal(nextStage(s), null);
});
test('the current stage is the latest event and risk from 0.4 is at risk', () => {
  assert.equal(stageOf([{ id: 1, stage: 'on_hold', at: '2026-10-29T09:00' }, { id: 2, stage: 'received', at: '2026-10-29T09:30' }]), 'received');
  assert.equal(atRisk(0.4), true); assert.equal(atRisk(0.39), false); assert.equal(atRisk(null), false);
});
```

- [ ] **Step 2: Run** `node --test server/test/shipment-stages.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** stages, store, pipeline hook (a reprocess that releases a held order adds `received`; an unchanged stage adds nothing).
- [ ] **Step 4: Run** `npm --prefix server test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(shipments): stage machine and events on gateway orders`.

### Task 5: Portal and dispatch API

**Files:**
- Create: `server/src/routes/portal.js`, `server/src/routes/dispatch.js`
- Modify: `server/src/index.js` (mount both under `/api`), `server/src/ingest/repository.js` (add `openOrders()` for dispatch if `clientOrders` doesn't fit)

**Interfaces:**
- Consumes: `req.user` (Task 2), `ingest.api`, `ingest.reprocess`, `ingestRepo.clientOrders/getOrder`, `apiOrderResult`, shipment store and `nextStage`/`stageOf`/`atRisk` (Task 4).
- Produces: `GET /portal/summary` → `{ client: {client_id, client_name, account_tier}, history: {orders, onTime, since}, open: {[stage]: count} }` (history = last 90 days before `DEMO_NOW` from `deliveries`); `POST /portal/orders` (form body → `ingest.api(user.client_id, [order])` → `{ ...apiOrderResult, stage }`); `GET /portal/orders` → list with `stage`, `atRisk`; `GET /portal/orders/:ref` → order + `events`; `PATCH /portal/orders/:ref` → reprocess; `GET /dispatch` → `{ [stage]: [{ref, client_id, client_name, carrier_id, promised_date, risk, atRisk}] }` excluding delivered/cancelled; `POST /dispatch/:ref/advance` → new stage, 409 `{ error: 'This order can't move from <stage>' }` when `nextStage` is null.

- [ ] **Step 1:** Implement both routers (thin: no business rules beyond calling Task 4's functions). Foreign refs → 404 `{ error: 'not_found' }`.
- [ ] **Step 2: Verify by hand** against the dev API with seeded demo users from `server/.env`: login as customer with `curl -c`, POST an order, GET it, login as staff, advance it, re-GET as customer shows `picked`; a customer GET of `/api/dispatch` returns 403. Expected: as listed.
- [ ] **Step 3: Commit** `feat(portal): customer orders and staff dispatch API`.

### Task 6: Web — public site, login and route split

**Files:**
- Create: `web/src/pages/Home.jsx`, `web/src/pages/Login.jsx`, `web/src/components/session.jsx` (`useSession()` → `{ user, loading, signIn(email,password), signOut() }` from `/api/session`)
- Modify: `web/src/main.jsx` or `App.jsx` (top-level routes: `/` Home, `/login` Login, `/portal/*` Portal (Task 7), everything else the existing story app); `App.jsx` NAV: "Start here" moves to `/start`, add `{ to: '/dispatch', label: 'Dispatch board', ... }` under a new section `5 · Run the company`; staff guard: no session → `/login`, customer → `/portal`; topbar shows the signed-in name and *Sign out*; `web/src/api.js` (a 401 from any call except `/session` sends the browser to `/login?expired=1`)

**Interfaces:**
- Produces: `useSession()`; routes `/`, `/login`, `/start`.

- [ ] **Step 1:** Implement. Home is static copy (no new public endpoint): company line, the on-time promise, three facts from the spec's history (48,340 deliveries Apr–Sep 2026, five carriers, our warehouses), *Sign in*. Login shows the `expired=1` note and the API's error text.
- [ ] **Step 2: Verify** in the browser: `/` loads signed out; staff page redirects to `/login`; signing in as staff lands on `/start`.
- [ ] **Step 3: Commit** `feat(web): public homepage, sign-in and staff guard`.

### Task 7: Web — customer portal and Dispatch board

**Files:**
- Create: `web/src/portal/PortalLayout.jsx`, `web/src/portal/Dashboard.jsx`, `web/src/portal/NewOrder.jsx`, `web/src/portal/Shipments.jsx`, `web/src/portal/Shipment.jsx`, `web/src/pages/Dispatch.jsx`
- Modify: `web/src/index.css` (portal layout, stage timeline, dispatch columns)

**Interfaces:**
- Consumes: Task 5 endpoints, `useSession` (Task 6).

- [ ] **Step 1:** Implement. Portal layout: top bar with client name, links Dashboard / New order / My shipments, *Sign out*; guard: staff → `/start`, signed out → `/login`. New order form fields: SKU, quantity, service (`next day`, `2-day`, `standard`, `same day`), ship-to name/street/city/state/zip, optional reference; on success go to `/portal/shipments/:ref`; issues shown beside fields. Shipment page: stage timeline (5 steps; `on_hold` shows the issues and a fix form calling PATCH), carrier, promised date, "At risk" badge. Dispatch: one column per stage, card = ref, client, carrier, promised date, risk badge, *Advance*; refresh after each advance.
- [ ] **Step 2: Verify** in the browser the demo flow from the spec's Goal.
- [ ] **Step 3: Commit** `feat(web): customer portal and dispatch board`.

### Task 8: End-to-end tests and docs

**Files:**
- Create: `e2e/global-setup.js` (signs in as the test staff user, saves `e2e/.auth/staff.json`), `e2e/portal.spec.js`
- Modify: `playwright.config.js` (server env adds `DEMO_STAFF_EMAIL=staff@halcyon.test`, `DEMO_STAFF_PASSWORD=e2e-only-staff`, `DEMO_CUSTOMER_EMAIL=buyer@c055.test`, `DEMO_CUSTOMER_PASSWORD=e2e-only-buyer`, `REQUIRE_LOGIN=1`; `globalSetup`; default `storageState` staff), `e2e/app.spec.js` (Start here path `/` → `/start`), `.gitignore` (`e2e/.auth/`), `README.md` (accounts, env vars, the demo flow)

- [ ] **Step 1: Write the e2e tests**
  - `customer places an order and tracks it while staff dispatch it`: customer context signs in → New order (SKU from the sample CSV, quantity 5, next day, a complete address) → lands on its shipment page showing `Received`; staff context opens `/dispatch`, advances that ref; customer reloads → `Picked`.
  - `a customer cannot open staff screens`: customer visits `/operations-day` → URL ends `/portal`; `page.request.get('/api/agents/datasets')` → 403.
  - `signed out visitors see the homepage and staff pages send them to sign in`: fresh context, `/` shows *Sign in*; `/operations-day` → `/login`.
  - `wrong password shows one message`: → text `Wrong email or password`.
  - `reloading a shipment page keeps the portal layout`: direct goto `/portal/shipments/<ref>` after sign-in shows the timeline.
- [ ] **Step 2: Run** `npx playwright test` — Expected: new tests fail before the config/fixes, then all pass (existing 30 + 5 new; the known message-drawer flake may need one rerun).
- [ ] **Step 3: Commit** `test(e2e): portal, dispatch and access; docs`.

### Task 9: Deploy readiness

- [ ] **Step 1:** `npm --prefix server test` and `npx playwright test` green; `npm --prefix web run build` clean.
- [ ] **Step 2:** Tell the user the four Azure App Settings to add (`DEMO_CUSTOMER_EMAIL`, `DEMO_CUSTOMER_PASSWORD`, `DEMO_STAFF_EMAIL`, `DEMO_STAFF_PASSWORD`; passwords of their choosing, entered by them) before the merge; push the branch only when they say so.
