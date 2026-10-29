# Live Order Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customer orders from email, EDI, API and the portal form are acted on by the five agents on a live order desk, shown to staff on one Live operations screen and to the customer on tracking, with a five-entry staff sidebar and 7-day sign-ins.

**Architecture:** A new `server/src/desk/` module maps live gateway orders (`inbound_orders`) to the agents' order shape and runs the existing `simulateDay` over the current desk run's orders, against the history's model and capacity. Decisions go to `agent_decisions` (run id `desk-<date>-<n>`), their effects are written onto the order and as shipment events. A persisted ops clock drives waves, collection and stages. The portal gains EDI/email/API-key/sample endpoints that call the gateway with the session's client forced.

**Tech Stack:** Node 22, Express 5, pg, `node:test`; React 19 + Vite; Playwright e2e (separate `halcyon_test` DB).

**Spec:** `docs/superpowers/specs/2026-10-29-live-order-desk-design.md`

**Branch:** `feature/live-desk` (from `feature/customer-portal`). Commit per task; do not push.

## Global Constraints

- Default ops clock when unset: Friday `2026-09-25 09:15`. Events: `08:00` wave 1, `13:00` wave 2 (`settings.secondWaveAt`), `14:00` collection, `23:59` end of day.
- Run id: `desk-<YYYY-MM-DD>-<n>`; a new run starts each time staff *set* the clock; *advancing* keeps the run.
- Approvals expire after 120 simulated minutes; the safe option stands.
- Claude reasons: `container.claude.explain(decision, context)`, 20 s timeout, `rules only` fallback, in the background.
- `DESK` env var: on unless `DESK=0`. With the desk off the gateway re-promises same-day after 08:00 exactly as today.
- Portal channel endpoints force `client_hint` = session `client_id` and `received_ts` = ops clock now on every record; nothing in the file can choose the client.
- Session lifetime `7 * 24 * 3600` s; renewed on use when less than half is left.
- Staff sidebar has exactly: The problem · Live operations · Operations day · Results · Evidence (collapsed: Carrier scorecard, Inventory placement, Test data).
- Copy: plain English, no internal ids or costs on customer screens.
- Match surrounding code style (small modules, a header comment per file, JSDoc on exports).

## Review Focus

1. A customer posting EDI/email whose sender or ISA id names another client must get orders for their own client only. (Task 2 test)
2. Re-running the desk (new order, approval, poll) must not duplicate decisions or notes. (Task 5 test)
3. Setting the clock twice starts two runs; orders from the first run are not live in the second. (Task 4 + Task 5 tests)
4. A held order (no region/warehouse) must not get stock or carrier decisions until fixed, and must not crash the run. (Task 3 test)
5. Server restart keeps the clock and run (persisted), and the desk rebuilds its state from the database. (Task 5 test)

---

### Task 1: Sign-ins last 7 days and survive restarts

**Files:**
- Modify: `server/src/auth/session.js`, `server/src/auth/access.js` (gate), `server/src/index.js`, `server/.env.example`
- Test: `server/test/auth-session.test.js`

**Interfaces:**
- Produces: `SESSION_TTL = 7 * 24 * 3600`; `shouldRenew(payload, nowSec) -> boolean` (true when `exp - nowSec < SESSION_TTL / 2`); `readSession` now also returns `exp`.

- [ ] **Step 1: Write failing tests** in `auth-session.test.js`:
  - `SESSION_TTL` equals `604800`.
  - `shouldRenew({ exp: now + 604800 }, now) === false`; `shouldRenew({ exp: now + 3600 }, now) === true`.
  - gate test: a request with a session whose `exp` is 1 hour away gets a `Set-Cookie` header starting `halcyon_session=`; one with 6 days left gets none.
- [ ] **Step 2:** `npm --prefix server test` → the new tests fail.
- [ ] **Step 3: Implement.** In `gate`, after `req.user` is set and the session should renew, set the cookie with `sessionCookie(issueSession(user, key), { secure })` (secure = `NODE_ENV === 'production'`; the gate needs `session_version` from the lookup row). In `index.js` log `JWT_SECRET is not set: every restart signs everyone out` once when it is unset outside production. Add `JWT_SECRET=` to `server/.env.example`.
- [ ] **Step 4:** `npm --prefix server test` → all pass.
- [ ] **Step 5: Commit** `fix(auth): 7-day sessions renewed on use; warn when JWT_SECRET is unset`.

### Task 2: Gateway: defer the cutoff to the Wave Planner; forced client and time

**Files:**
- Modify: `server/src/ingest/pipeline.js` (`decide`), `server/src/ingest/IngestService.js`, `server/src/container.js`
- Test: `server/test/ingest.test.js`

**Interfaces:**
- Produces: `new IngestPipeline({ ..., deferCutoff: boolean })`. With `deferCutoff` true a same-day order received after 08:00 keeps `commitment_type = 'same_day'`, gets no correction, and gets issue `{ code: 'same_day_after_cutoff', severity: 'info', message: 'Received HH:MM, after the 08:00 pick-list cutoff: the Wave Planner decides' }`; `promised_date` is the received date.
- Produces: every `IngestService` channel method takes an optional last argument `force = { client_id, received_ts }`: `email(raw, opts, force)`, `edi(raw, opts, force)`, `api(clientId, orders, force)`. When given, every record gets `client_hint = force.client_id` and `received_ts = force.received_ts` before the pipeline.
- Produces: `IngestService` constructor option `clock: () => string | null` ('YYYY-MM-DD HH:MM'); when it returns a value it is the pipeline's `fallbackTs` for records without their own time.

- [ ] **Step 1: Failing tests:**
  - `deferCutoff`: same-day at `2026-09-25 09:15` → status not corrected for commitment, `commitment_type === 'same_day'`, issue code `same_day_after_cutoff` with severity `info`. Without it → corrected to next-day (existing behaviour, keep its test).
  - Forced client: EDI whose ISA sender is `C001` posted with `force.client_id = 'C055'` → every order `client_id === 'C055'`. Same for an email from `orders@client001.example`.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3: Implement.** Container passes `deferCutoff: process.env.DESK !== '0'`.
- [ ] **Step 4:** run → pass.
- [ ] **Step 5: Commit** `feat(gateway): leave the 8 AM cutoff to the Wave Planner; force client and time for portal orders`.

### Task 3: Desk core: gateway order → agents → effects (pure)

**Files:**
- Create: `server/src/desk/mapping.js`, `server/src/desk/effects.js`
- Test: `server/test/desk-core.test.js`

**Interfaces:**
- Consumes: `simulateDay`, `approvalKey`, `isFriday`, `randForDay` (`agents/simulator.js`); `validateAddress` (as used in `ingest/pipeline.js`); `orderRef` (`shipments/views.js`).
- Produces: `toAgentOrder(row, { client, distances, stockMiss, threshold }) -> agentOrder` where `row` is an `inbound_orders` row with `normalized`; fields: `delivery_id = orderRef(row.id)`, `order_id = row.id`, `client_id`, `client_name`, `account_tier`, `account_status`, `commitment_type` (`normalized.commitment_type`), `received_ts` (`normalized.received_ts`, 'YYYY-MM-DD HH:MM'), `destination_region`, `nearest_warehouse_id = row.warehouse_id`, `fulfilment_warehouse_id = row.warehouse_id`, `distance_miles`, `address_incomplete` (1 when `row.status === 'held'`), `stock_miss` (1 when `stockMiss(client, region) >= threshold`), `carrier_id = row.carrier_id`, `cutoff_breach` (1 when same_day and received after 08:00), `order_channel`.
- Produces: `deskDecide(agentOrders, ctx) -> { decided, decisions }` = `simulateDay` over the orders that have a region and warehouse, plus intake-only for held ones (held orders get no stock/carrier/wave/watchtower decision).
- Produces: `effectsOf(decision, decidedOrder, approval) -> { fields: {commitment_type?, promised_date?, carrier_id?, warehouse_id?, release?: true}, note: string } | null`, approval ∈ `auto | pending | approved | rejected | expired`. Notes (exact copy):
  - wave 2: `Second pick wave at 13:00: still same-day`; wave pending: `Waiting for approval to join the second wave`; wave rejected/expired: `Second wave full: promised next-day` (fields: commitment `next_day`, promised next day).
  - intake fix: `Address completed from the client's records` (release); intake query: `Address query sent to the client`.
  - stock: `Stock moved to the nearest warehouse (<WH>)`.
  - carrier: `Carrier <X> chosen: more reliable on this lane` (only when it differs from the gateway's); pending: `Carrier <X> waiting for approval (over the cost limit)`.
  - watchtower upgrade: `Moved to carrier <X> before the 14:00 collection`; notify: `Client told about the risk of a late delivery`.

- [ ] **Step 1: Failing tests** (fixture world from a few hundred synthetic history rows like `agents-liveday.test.js` builds):
  - mapping of a corrected same-day EDI row at 09:15 → `cutoff_breach 1`, `commitment_type 'same_day'`, `delivery_id 'IN-000007'`.
  - held row → `deskDecide` returns no decision for it except intake; no throw.
  - each `effectsOf` note above for its case; carrier unchanged → `null`.
- [ ] **Step 2:** run → fail. **Step 3:** implement. **Step 4:** run → pass.
- [ ] **Step 5: Commit** `feat(desk): map gateway orders to the agents and describe their effects`.

### Task 4: Ops clock and stages over time

**Files:**
- Create: `server/src/desk/clock.js`, `server/src/desk/repository.js`
- Modify: `db/schema.sql` (table + DROP list), `server/src/index.js` (ensure table at startup)
- Test: `server/test/desk-clock.test.js`

**Interfaces:**
- Produces table `desk_clock (id int PRIMARY KEY DEFAULT 1, set_to timestamp NOT NULL, set_at timestamptz NOT NULL, run_no int NOT NULL, run_started_at timestamptz NOT NULL)`; `ensureDeskTable()`.
- Produces (pure, `clock.js`): `clockNow(row, realNow: Date) -> 'YYYY-MM-DD HH:MM'` (`set_to + (realNow - set_at)`; default row when null: set_to `2026-09-25 09:15`, set_at = realNow); `runIdOf(row) -> 'desk-<date of set_to>-<run_no>'`; `nextEvent(now) -> 'YYYY-MM-DD HH:MM'` (next of 08:00, 13:00, 14:00, 23:59 after `now`, else next day 08:00); `dueStage(order, now) -> stage` with order `{ stage, wave (1|2|null), commitment_type, promised_date, received_ts }`: picked at 08:00 (wave 1, received before 08:00) or 13:00 (wave 2) on the received date, next-day/standard orders picked at 08:00 the day after; collected at 14:00 the pick day; in_transit after collection; delivered at 23:59 of `promised_date`; never moves `on_hold`/`cancelled`; never moves backwards.
- Produces (`repository.js`): `deskRepo.getClock()`, `deskRepo.setClock(setTo)` (run_no+1, set_at = run_started_at = now()), `deskRepo.shiftClock(to)` (same run: set_to = to, set_at = now()), `deskRepo.liveOrders(runStartedAt)` (inbound_orders with status accepted/corrected/held and `created_at >= runStartedAt`, joined to clients for name/tier/status), `deskRepo.updateOrder(id, fields)`, `deskRepo.addNoteOnce(orderId, stage, note)` (no insert when that order already has that note), `deskRepo.decisions(runId)`, `deskRepo.updateDecision(id, { decision, rule })`.

- [ ] **Step 1: Failing tests** for the pure functions: `clockNow` 10 real minutes after setting 09:15 → `09:25`; `runIdOf({set_to:'2026-09-25 07:30', run_no:3})` → `desk-2026-09-25-3`; `nextEvent('2026-09-25 09:15')` → `2026-09-25 13:00`; `nextEvent('2026-09-25 23:59')` → `2026-09-26 08:00`; `dueStage` for wave 2 order at 13:00 → `picked`, at 14:00 → `collected`, at 23:59 same-day promised that date → `delivered`; held stays `on_hold`.
- [ ] **Step 2:** run → fail. **Step 3:** implement. **Step 4:** run → pass.
- [ ] **Step 5: Commit** `feat(desk): ops clock, runs and stage timing`.

### Task 5: Desk service, staff API and hooks

**Files:**
- Create: `server/src/desk/service.js`, `server/src/routes/desk.js`
- Modify: `server/src/container.js` (create desk, pass `clock` to IngestService, call `desk.refresh()` after each ingest), `server/src/routes/agents.js` (approval on a `desk-` run → `desk.refresh()`), `server/src/routes/ingest.js` + `server/src/routes/portal.js` (refresh after ingest), `server/src/index.js` (mount)
- Test: `server/test/desk-service.test.js`

**Interfaces:**
- Consumes: Tasks 3–4; `decisionLog` (or `createMemoryLog()` in tests); `world()` from `routes/agents.js` (history orders, distances, rates); `StockAgent` as `LiveDay` uses it to learn `stockPairs` from the history before the clock's date; `buildWorld`.
- Produces: `createDesk({ repo, log, world, claude, settings, now = () => new Date() })` → `{ refresh(), state(), setClock(setTo), advance(), advanceOrder(ref), clockNow() }`, all serialized like `LiveDay.#serial`.
  - `refresh()`: load clock + live orders → `toAgentOrder` → `deskDecide` with approvals from the run's decision rows → for each decision: insert if its `approvalKey` is new for this run (`sim_ts` = clock now, approval `pending` when `needsApproval` else `auto`), else `updateDecision` when content changed → expire pending older than 120 sim-minutes → apply `effectsOf` (`updateOrder`, `addNoteOnce`; release → `shipmentStore.recordVerdict`) → move stages with `dueStage` via `shipmentStore.advance`, giving each order `wave = 2` when it has an effective wave-2 decision, else 1 → explain new notable decisions with Claude in the background (`setReason`).
  - A `refresh()` that throws is caught and logged (`Desk run failed: <message>`); orders keep the gateway's values and `state()` marks them `agentsRun: false` (shown as "agents not run").
  - `state()` → spec's `GET /desk` shape: `{ clock: { now, runId }, orders: [...], approvals: [...pending], counts: { intake, wave, stock, carrier, watchtower } }`; each order's `checks` = the gateway `issues` + `corrections`.
  - `advance()` → `shiftClock(nextEvent(now))` then `refresh()`; `advanceOrder(ref)` → one stage via `shipmentStore.advance` then `refresh()`.
- Produces routes (staff): `GET /api/desk`, `POST /api/desk/clock {set_to}` (400 unless 'YYYY-MM-DD HH:MM'), `POST /api/desk/advance`, `POST /api/desk/orders/:ref/advance`.

- [ ] **Step 1: Failing tests** with an in-memory repo and `createMemoryLog()`:
  - two `refresh()` calls → same decision count, no duplicate notes.
  - approving the pending carrier decision then `refresh()` → order `carrier_id` becomes the approved carrier; note `Carrier <X> chosen…` present once.
  - a pending decision 121 sim-minutes old → `expired`.
  - `setClock` twice → second run's `state().orders` excludes orders created before it.
  - a desk rebuilt from the same repo/log (restart) → identical `state()`.
- [ ] **Step 2:** run → fail. **Step 3:** implement. **Step 4:** `npm --prefix server test` → all pass.
- [ ] **Step 5: Commit** `feat(desk): agents act on live orders; staff desk API`.

### Task 6: Portal channels and the five samples

**Files:**
- Create: `server/data/samples/1-email.eml`, `2-edi.x12`, `3-api.json`, `4-form.json`, `5-api.json`, `server/scripts/check-samples.mjs` (+ `"check:samples"` script)
- Modify: `server/src/routes/portal.js`, `server/src/ingest/repository.js` / `api_clients` helper for key rotation
- Test: `server/test/portal-channels.test.js`, e2e in Task 9

**Interfaces:**
- Produces: `POST /api/portal/edi` (text), `POST /api/portal/email` (text) → `{ orders: [...shipments] }`; `POST /api/portal/samples/:n` (1–5) → `{ channel, orders }`; `POST /api/portal/api-key` → `{ client_id, secret, token_url: '/api/auth/login', docs_url: '/api/docs' }` (secret shown once, stored hashed with `hashSecret`); `GET /api/portal/orders/:ref` adds `decisions: [{ agent, text, at }]` (plain reason; no ids, costs or approval internals).
- Samples are for the demo customer's client (`DEMO_CUSTOMER_CLIENT`, default `C055`) with no timestamps. Choose contents from the history so that on clock `2026-09-25 09:15` each triggers its cause: 1 email with an incomplete address (no zip/street number); 2 EDI X12 850 `same_day`; 3 API order to a region where `C055|region` is in the Stock agent's pairs; 4 form order, `same_day` or Tier 1, whose gateway carrier is `D` and whose best A/B/C carrier is over the `$6` cap; 5 API order with gateway risk ≥ 0.4 that Watchtower upgrades. If C055 cannot trigger one cause, change `DEMO_CUSTOMER_CLIENT`'s default to a client that can trigger all five and note it in the commit.
- `check-samples.mjs` sets the clock, sends all five through the service and prints each sample's agents' decisions; exits 1 if any expected agent decision is missing.

- [ ] **Step 1: Failing tests** (route-level with the existing test helpers): EDI with ISA sender `C001` posted by a C055 customer → orders `client_id 'C055'`; `samples/9` → 404; `api-key` returns a secret that `/api/auth/login` accepts, and a second call invalidates the first.
- [ ] **Step 2:** run → fail. **Step 3:** implement; write the samples; `npm --prefix server run check:samples` against the local DB → all five expected decisions.
- [ ] **Step 4:** run tests → pass.
- [ ] **Step 5: Commit** `feat(portal): orders by EDI, email and API key; five sample orders, one per cause`.

### Task 7: Customer portal: Place orders tabs and "What we did"

**Files:**
- Modify: `web/src/portal/NewOrder.jsx` (→ tabbed Place orders), `web/src/portal/Shipment.jsx`, `web/src/portal/PortalLayout.jsx` (nav label "Place orders"), `web/src/index.css`

**Interfaces:**
- Consumes: Task 6 endpoints.
- Tabs: `Form` (existing form) · `Upload EDI` (file drop + textarea) · `Send email` (file drop of .eml or paste) · `API` (base URL, docs link, Create API key button showing the secret once with copy). Each tab: `Send a sample` → `/portal/samples/:n` for that channel (Form → 4, EDI → 2, Email → 1, API → 3 and 5). After any send: a result list linking each new order to its tracking page.
- Shipment page: a "What we did" list from `decisions` (agent name + text + time), above the timeline.

- [ ] **Step 1:** implement; `npm --prefix web run build` → builds.
- [ ] **Step 2:** check in the browser (local servers), signed in as the demo customer: each tab sends its sample and links to tracking.
- [ ] **Step 3: Commit** `feat(portal): place orders by form, EDI, email or API; tracking shows what the agents did`.

### Task 8: Staff side: Live operations and the five-entry sidebar

**Files:**
- Create: `web/src/pages/LiveOps.jsx`, `web/src/pages/Problem.jsx`, `web/src/pages/Results.jsx`
- Modify: `web/src/App.jsx` (NAV), `web/src/index.css`
- Delete from NAV and the story (files may stay): StartHere, WhyLate, Agents, Decision, Inbound, AiModel, DataQuality, Accounts, ControlTower, Dispatch

**Interfaces:**
- Consumes: Task 5 routes; `POST /api/agents/approvals/:id`.
- `LiveOps.jsx`: clock with `Set clock` (default value `2026-09-25 07:30`) and `Advance to next event`; orders table (ref, client, channel, received, stage, promised, carrier, risk); expanding a row shows gateway checks and each agent decision with its reason and an AI/rules badge; approval queue with Approve/Reject; per-order `Move on`; five-agent strip with counts. Polls `GET /api/desk` every 4 s.
- `Problem.jsx`: headline (71.0% vs 94%) and the five causes with counts and cost, taken from the existing `/api/agents/causes` data that WhyLate uses; no other sections.
- `Results.jsx`: `<SixMonths />` then `<Decision />` content.
- NAV exactly per Global Constraints; Evidence is a collapsed group (closed by default) holding Carrier scorecard, Inventory placement, Test data. Landing path for staff: `/problem`.

- [ ] **Step 1:** implement; `npm --prefix web run build` → builds.
- [ ] **Step 2:** browser check as staff: sidebar shows exactly the five entries; Live operations shows orders sent in Task 7, approval works, Advance moves stages.
- [ ] **Step 3: Commit** `feat(ops): Live operations desk; staff side cut to five screens`.

### Task 9: End-to-end journey

**Files:**
- Modify: `e2e/app.spec.js`, `playwright.config.js` (`DESK: '1'`, `JWT_SECRET` test value)

- [ ] **Step 1: Write the e2e test** `end to end: five channels, five causes, approval, delivered`: customer signs in → sends samples 1–5 → staff sign in → Live operations shows 5 orders with decisions from intake, wave, stock, carrier (pending) and watchtower → approve the carrier decision → Advance until end of day → customer tracking of sample 2 shows `Second pick wave at 13:00: still same-day` and stage delivered. Plus: staff sidebar has exactly the five entries.
- [ ] **Step 2:** remove or rewrite e2e tests for screens no longer in the sidebar (keep their API checks where still meaningful).
- [ ] **Step 3:** `npx playwright test` → all pass; `npm --prefix server test` → all pass.
- [ ] **Step 4: Commit** `test(e2e): the whole order journey across channels, agents, staff and customer`.
