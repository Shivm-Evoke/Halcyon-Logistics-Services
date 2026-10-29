# Three-sided demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the review's Part A findings, then add a demo where one order goes Client portal → Halcyon gateway, agents and approvals → public tracking page, all three views reading one order event log.

**Architecture:**
- The portal posts through the existing client API path (`IngestService.api`). Every pipeline outcome appends to a new `order_events` table.
- A small "golden thread" runner calls the agents' pure functions (`planWaves`, `allocateCarriers`, and the Watchtower's notify rule) for one gateway order. It writes an event per step and parks on a real `agent_decisions` approval.
- New web routes (`/login`, `/portal`, `/ops`, `/track/:token`) are added in `main.jsx` around the untouched `App`.

**Tech Stack:** Node 22 + Express 5, PostgreSQL (`pg`), `node --test`, React 19 + react-router-dom 7 + Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-three-sided-demo-design.md`

## Global Constraints

- The 14 existing screens and their analysis numbers don't change, except for the Part A fixes.
- No real auth, email or SMS. Simulated things are labelled "demo".
- Clients C001–C280 only. The demo client is **C190** (Tier 1, SLA, threatening_to_leave, Southeast → warehouse **W3**).
- Must work with AI offline (rules fallback, with the reason shown).
- New schema only through `CREATE … IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` at startup. Never `load.sh` in production.
- Only `/api/track/:token` becomes a new open (no `SITE_PASSWORD`) path.
- Reuse `index.css` classes (`card`, `btn`, `badge b-*`, `input`, `field`, `ops-event`) and `components/ui.jsx`.
- Commit and push to `origin Mohit-Evoke` after each task. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test commands: `npm --prefix server test` (unit), `npm run test:e2e` (Playwright, uses its own `halcyon_test` DB on :4100/:5174).

## File map

| File | Responsibility |
|---|---|
| `server/src/rules.js` | `promiseDelivery` gains an optional wave-2 branch (the one promise rule) |
| `server/src/ingest/pipeline.js` | Uses the wave-2 branch with a per-day ledger; appends order events |
| `server/src/ingest/repository.js` | `wave2Usage(day, warehouse)` |
| `server/src/quality/ClientProfiler.js` | Null-safe rarity checks; `impossible_promise` uses the second wave |
| `server/src/agents/claude.js` | `probe()`, `status()`, `lastError` |
| `server/src/routes/health.js` (new) | `GET /api/health/ai` |
| `server/scripts/seed-demo-week.mjs` (new), `Dockerfile`, `server/scripts/start.sh` | Test pack and demo week in production |
| `server/src/orders/events.js` (new) | `order_events` table, `appendEvent`, `timeline`, tokens |
| `server/src/orders/thread.js` (new) | Golden-thread runner (pure functions + an injected store) |
| `server/src/routes/orders.js` (new) | Portal, ops, simulation, reset and tracking endpoints |
| `web/src/main.jsx` | Top-level `<Routes>` around `App` |
| `web/src/demo/*` (new) | `persona.js`, `Timeline.jsx`, `Login.jsx`, `Portal.jsx`, `Ops.jsx`, `Track.jsx`, `demo.css` |
| `e2e/demo.spec.js` (new) | Full storyboard |

---

### Task 1: One promise rule (A6)

**Files:**
- Modify: `server/src/rules.js:94-115`, `server/src/ingest/pipeline.js:102-139`, `server/src/ingest/repository.js` (add one query), `server/src/quality/ClientProfiler.js:42-44`
- Test: `server/test/rules.test.js`, `server/test/ingest.test.js`

**Interfaces:**
- Produces: `promiseDelivery({ receivedTs, commitmentType, secondWaveAt?, wave2Room? })` → existing fields plus `wave: 1 | 2 | 'next'`. Without `secondWaveAt` the behaviour is unchanged (backtest and tests stay identical).
- Produces: `repo.wave2Usage(day, warehouseId) → Promise<number>`.

- [ ] **Step 1: Failing tests** in `server/test/rules.test.js`:

```js
test('same-day after 08:00 keeps same-day on the second wave when the warehouse has room', () => {
  const p = promiseDelivery({ receivedTs: '2026-10-27T10:15', commitmentType: 'same_day', secondWaveAt: '13:00', wave2Room: true });
  assert.equal(p.offeredCommitment, 'same_day');
  assert.equal(p.wave, 2);
  assert.equal(p.pickListDate, '2026-10-27');
  assert.equal(p.promisedDate, '2026-10-28');
});
test('same-day after 08:00 is re-promised next-day when the second wave is full or already gone', () => {
  const full = promiseDelivery({ receivedTs: '2026-10-27T10:15', commitmentType: 'same_day', secondWaveAt: '13:00', wave2Room: false });
  const late = promiseDelivery({ receivedTs: '2026-10-27T13:05', commitmentType: 'same_day', secondWaveAt: '13:00', wave2Room: true });
  for (const p of [full, late]) { assert.equal(p.offeredCommitment, 'next_day'); assert.equal(p.wave, 'next'); }
});
test('without a second wave the rule is unchanged', () => {
  const p = promiseDelivery({ receivedTs: '2026-10-27T10:15', commitmentType: 'same_day' });
  assert.equal(p.offeredCommitment, 'next_day');
  assert.equal(p.wave, 'next');
});
```

- [ ] **Step 2:** Run `npm --prefix server test`. Expected: the 3 new tests FAIL (`wave` is undefined).
- [ ] **Step 3: Implement** in `rules.js`:

```js
export function promiseDelivery({ receivedTs, commitmentType, secondWaveAt = null, wave2Room = false }) {
  const [date, time = '00:00'] = receivedTs.replace(' ', 'T').split('T');
  const hhmm = time.slice(0, 5);
  const afterCutoff = hhmm >= PICK_LIST_CUTOFF;
  // One rule for the gateway and the Wave Planner: a same-day order after the cutoff keeps its promise on the
  // second pick list when the warehouse has room before it closes; otherwise it ships tomorrow and is re-promised.
  const secondWave = commitmentType === 'same_day' && afterCutoff && secondWaveAt && hhmm < secondWaveAt && wave2Room;
  const pickListDate = afterCutoff && !secondWave ? addDays(date, 1) : date;
  const fixSameDay = commitmentType === 'same_day' && afterCutoff && !secondWave;
  const promisedDate = addDays(fixSameDay ? pickListDate : date, CLASS_DAYS[commitmentType]);
  return {
    afterCutoff, pickListDate, promisedDate,
    wave: !afterCutoff ? 1 : secondWave ? 2 : 'next',
    legacyPromisedDate: addDays(date, CLASS_DAYS[commitmentType]),
    offeredCommitment: fixSameDay ? 'next_day' : commitmentType,
    note: secondWave ? `After the ${PICK_LIST_CUTOFF} cutoff: joins the ${secondWaveAt} second pick list, same-day kept.`
      : fixSameDay ? `Received after the ${PICK_LIST_CUTOFF} pick-list cutoff, so it ships tomorrow. Offer next-day (${promisedDate}) instead of same-day.`
        : afterCutoff ? `After cutoff: goes on the ${pickListDate} pick list; promise still achievable.`
          : `Makes today's ${PICK_LIST_CUTOFF} pick list.`,
  };
}
```

- [ ] **Step 4:** In `ingest/repository.js`, add:

```js
  wave2Usage: async (day, warehouseId) => Number((await one(`
    SELECT count(*) AS n FROM inbound_orders
    WHERE warehouse_id = $2 AND (normalized->>'wave') = '2' AND (normalized->>'pick_list_date') = $1
      AND status IN ('accepted', 'corrected')`, [day, warehouseId]))?.n || 0),
```

- [ ] **Step 5:** In `pipeline.js` `decide()`:
  - Compute `region` and `warehouse_id` before the promise.
  - Read wave-2 room from a per-message ledger seeded by `repo.wave2Usage`, using `DEFAULT_SETTINGS.secondWaveAt` and `wave2CapacityPerWarehouse` from `../agents/settings.js`.
  - Set `order.wave = promise.wave`, and increment the ledger when wave 2 is taken and the order isn't held.
  - The existing correction/issue for `offeredCommitment !== requested` stays.
  - When `promise.wave === 2`, push `issues.push({ code: 'second_wave', severity: 'warning', field: 'commitment_type', message: `Received ${hhmm}, after 08:00: on the 13:00 second pick list, same-day kept` })`.
  - Move `const warehouse_id = region ? this.nearest[region] : null;` above the promise.
- [ ] **Step 6:** `ClientProfiler.js:42-44`: `impossible_promise` fires only when same-day is received at or after `DEFAULT_SETTINGS.secondWaveAt` (was hour ≥ 8).
- [ ] **Step 7:** Add an `ingest.test.js` case. The fake repo's `wave2Usage` returns 0. A same-day order at 10:15 is accepted with `commitment_type 'same_day'` and a `second_wave` issue. With `wave2Usage` returning 30 it is re-promised `next_day`.
- [ ] **Step 8:** Run `npm --prefix server test`. Expected: all pass.
- [ ] **Step 9:** Commit `feat(rules): one promise rule for gateway and wave planner (second wave if room, else re-promise)` and push.

### Task 2: Small correctness fixes (A4b, A5 must-haves)

**Files:** `server/src/quality/ClientProfiler.js:45-52`, `web/src/pages/StartHere.jsx` (lines with "~$1M", "94%", "out of stock on 14%"), `web/src/pages/AiModel.jsx:61`, `README.md`; test `server/test/ml.test.js` (or the existing anomaly test file).

- [ ] **Step 1: Failing test.** `inspect({ client_id: 'C001', destination_region: null, order_channel: 'API', commitment_type: 'standard', received_hour: 10 })` returns no finding whose message contains `null`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** In each rarity check in `ClientProfiler.inspect`, guard with `if (value != null)` before calling `share()`.
- [ ] **Step 4: Copy fixes:**
  - StartHere `~$1M net` → `~$0.9M net` (matches `simulator.js` netUsd $896,688).
  - Headline wording → "94% of late deliveries have a cause other than route planning; 67% go wrong before the truck leaves". Add `67%` computed as (address + cutoff + stock late) / all late. Use the same `/overview` cause counts that StartHere already loads.
  - "out of stock on 14%" → "shipped from a farther warehouse on 14%".
  - AiModel x-axis labels: map scenario names to `['Today', 'AI carrier', 'Data fixes', 'Full AI']` for the tick only, keeping full names in the tooltip.
  - Label the bar card "September backtest (ML policy)" with a note "The six-month replay with rule-based agents reaches 91.3%".
- [ ] **Step 5:** `npm --prefix server test` passes; `npm --prefix web run build` succeeds.
- [ ] **Step 6:** Commit `fix: null in anomaly text; consistent headline, savings, stock and chart labels` and push.

### Task 3: AI health (A2)

**Files:** `server/src/agents/claude.js`, new `server/src/routes/health.js`, `server/src/index.js`, `server/src/agents/liveDay.js:286`, `web/src/pages/OperationsDay.jsx:136`; test `server/test/agents-claude.test.js`.

**Interfaces:**
- Produces: `claude.status() → { configured, model, state: 'not_configured'|'unknown'|'ok'|'auth'|'not_found'|'timeout'|'error', reason, checkedAt }` and `claude.probe() → Promise<status>`.

- [ ] **Step 1: Failing tests.**
  - `createClaude({ client: null }).status().state === 'not_configured'`, and the reason mentions `ANTHROPIC_FOUNDRY_API_KEY`.
  - A fake client that throws `{ status: 404 }` makes `probe()` return `state 'not_found'`.
  - A failing `explain()` records `status().state` as `error` or the mapped state.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Inside `createClaude`, keep `let last = { state: client ? 'unknown' : 'not_configured', reason: client ? null : 'ANTHROPIC_FOUNDRY_API_KEY and ANTHROPIC_FOUNDRY_RESOURCE (or _BASE_URL) are not set', checkedAt: null }`.
  - `classify(e)` maps: 401/403 → `auth`, 404 → `not_found` (reason `deployment "${MODEL}" not found`), message `timed out` → `timeout`, else `error`.
  - Each `catch` calls `last = { ...classify(e), checkedAt: new Date().toISOString() }`; each success sets `state 'ok'`.
  - `probe()` calls `call({ max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] })`, cached for 5 minutes.
  - `status()` returns `{ configured: available, model: MODEL, ...last }`.
- [ ] **Step 4:** `routes/health.js`: `GET /health/ai` → `res.json(await (await getContainer()).claude.probe())`. Never include the key. Mount it in `index.js` with the other routers (behind `SITE_PASSWORD`).
- [ ] **Step 5:**
  - `liveDay.js:286`: add `aiStatus: this.claude?.status?.() ?? null` next to `aiAvailable`.
  - `OperationsDay.jsx:136`: show `AI offline: rules running (${aiStatus.reason})` when it isn't available or `state !== 'ok'`.
- [ ] **Step 6:** Tests pass, then commit `feat(agents): AI health check and fallback reason` and push.
- [ ] **Step 7 (ops, not code):** Tell the user to set `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_RESOURCE`, and `CLAUDE_MODEL` (the exact Foundry deployment name) in the Azure Web App → Configuration.

### Task 4: Test pack and demo week in production (A3)

**Files:** `Dockerfile`, new `server/scripts/seed-demo-week.mjs`, `server/scripts/start.sh`, `server/src/routes/ingest.js:146-151`, `server/src/ingest/repository.js` (settings table helper).

- [ ] **Step 1: Dockerfile.** After `COPY ingest/ ingest/`, add `RUN node ingest/generate-test-data.mjs && node ingest/generate-live-week.mjs`. Both generators are deterministic and read only `db/data`.
- [ ] **Step 2: `seed-demo-week.mjs`.**
  - Builds the container (`getContainer()`), reads `ingest/live-week/manifest.json`, and sends every message through `container.ingest` in-process (email via `.email(raw)`, EDI via `.edi`, API via `.api(client, orders)`, files via `.csvFile`).
  - Scores the results against the manifest exactly as `ingest/run-live-week.mjs` does. Import its scoring function; if it isn't exported, export `scoreWeek(manifest, results)` from it first.
  - Writes the report into a new `app_state(key text PRIMARY KEY, value jsonb)` table (created `IF NOT EXISTS`) under key `live_week_report`.
- [ ] **Step 3: `start.sh`.** After the DB load block, run the seeder `if [ "${SEED_DEMO_WEEK:-0}" = 1 ]` and `SELECT count(*) FROM inbound_messages` returns 0.
- [ ] **Step 4:** `GET /ingest/live-week` reads `app_state.live_week_report` first, then falls back to the file. Add `POST /ingest/live-week/run` (behind `SITE_PASSWORD`) to run the seeder function in-process.
- [ ] **Step 5:** Local check: `docker build -t halcyon-test .` succeeds and `docker run --rm halcyon-test ls ingest/test-data/email | head` lists files.
- [ ] **Step 6:** Commit `fix(deploy): ship the test pack and seed the demo week` and push. Tell the user to set `SEED_DEMO_WEEK=1` in Azure.

### Task 5: Routing reframe (A1)

**Files:** `db/schema.sql:104-124`, `server/src/routes/agents.js:135-138` (`/agents/causes` routing query), `server/src/routes/overview.js:52-56`, `web/src/pages/WhyLate.jsx:40-85`, `web/src/pages/StartHere.jsx` (lines 26-27, 35, 55, 96, 106-107 and the Known vs assumed table), `web/src/pages/Decision.jsx:26-33`, `web/src/api.js:60`, `README.md:3-4,11,16,162`.

- [ ] **Step 1: View.** In `v_deliveries`, add `actual_route_km / NULLIF(planned_route_km, 0) - 1 AS detour` and a `f_detour` flag (`detour > 0.2`). Split the final `residual` branch of the cause CASE into `'route_detour'` when `f_detour` and `'unexplained'` otherwise. On an existing database the view is recreated by a `CREATE OR REPLACE VIEW` run at startup through a new `ensureViews()` in `server/src/db.js`. The DDL lives in `db/views.sql`, so `schema.sql` and startup share it.
- [ ] **Step 2: Causes query.** In `/agents/causes`, return `routing: { clean_late_detour, clean_ontime_detour, detour_only_late: 832, detour_late_incl_carrier: 1354, share_of_late, points }`, computed by SQL on clean orders (`NOT f_address AND NOT f_cutoff AND NOT f_stock`) split by `is_late`.
- [ ] **Step 3: Copy.** The single source string, used on every screen:
  > "Route execution, not route planning: late clean orders drove 18% over the planned distance against 8% for on-time ones. Detours over 20% are linked to 6–10% of late deliveries (832 with no other cause, +1.7 pts; 1,354 including slow carriers, +2.8 pts). It is measured after the trip, so it shows correlation. Scope the vendor PoC down to driver route adherence; it doesn't justify $680K as scoped."
  - Replace "5 causes, 0 from routing" with "5 upstream causes + route execution (~6–10%)".
  - Replace "…over the planned distance on every route, on time or late" with the 18% vs 8% split.
  - Add a Known vs assumed row: "Detours over 20% coincide with lateness" (Known); "A routing product would prevent them" (Assumed; test: a driver route-adherence pilot).
  - `api.js:60`: rename the label `routing-addressable` → `route detour`.
- [ ] **Step 4:** Update existing e2e/unit assertions that match old copy (grep `0 from routing`, `on time or late`).
- [ ] **Step 5:** Server tests pass, the web build passes, then `npm run test:e2e`.
- [ ] **Step 6:** Commit `fix(analysis): route execution explains ~6–10% of lateness; reframe the vendor decision` and push.

### Task 6: Event log and golden-thread runner

**Files:** new `server/src/orders/events.js`, `server/src/orders/thread.js`, `server/src/routes/orders.js`; modify `server/src/ingest/pipeline.js` (append events), `server/src/routes/agents.js:110-116` (actor + resume), `server/src/agents/watchtower.js` (export the notify rule), `server/src/index.js`; tests `server/test/orders-thread.test.js`.

**Interfaces:**
- `events.js`:
  - `ensureOrderEventsTable()`
  - `appendEvent(orderId, actor, type, detail = {})` → row
  - `timeline(orderId)` → rows ordered by ts, id
  - `orderByToken(token)` → inbound_orders row
  - `newToken()` → 16 hex characters
- `watchtower.js`: `export const needsClientNotice = (o) => o.account_tier === 'Tier 1' || o.account_status === 'threatening_to_leave';` (used inside `watch` too).
- `thread.js`: `createThread({ store, world, settings, claude })` with:
  - `release(orderRow)`: wave → carrier → `tracking_sent` events
  - `carrierEvent(orderRow, type)`: `shipped` | `delayed` | `delivered`; `delayed` → `risk_flagged` and either `approval_requested` or `client_notified`
  - `resume(decisionRow)`: after approval → `approved` + `client_notified`; after rejection → `rejected`
- The `store` interface (memory fake in tests; DB in production):
  - `append(orderId, actor, type, detail)`
  - `requestApproval({ orderId, step, detail })` → decision row with `run_id = 'thread'`, `agent = 'watchtower'`, `delivery_id = 'IN-xxxxxx'`
  - `notify(orderRow, message, actor)`
  - `client(clientId)`

- [ ] **Step 1: Failing tests** (`orders-thread.test.js`, memory store, `world` stub with `model.pOnTime = () => 0.95`, `limits = { A: 99, B: 99, C: 99, D: 99, E: 99, F: 99 }`, the real `rates`):

```js
test('a released same-day Tier 1 order goes on the second wave and to A, B or C, with an event per step', async () => {
  const { thread, events } = setup();
  await thread.release(order({ received_ts: '2026-10-27 10:15', commitment_type: 'same_day', wave: 2 }));
  assert.deepEqual(events.map((e) => e.type), ['wave_assigned', 'carrier_selected', 'tracking_sent']);
  assert.ok(['A', 'B', 'C'].includes(events[1].detail.carrier_id));
  assert.equal(events[0].detail.wave, 2);
});
test('a delay on an at-risk client asks for approval before the client is told', async () => {
  const { thread, events, approvals } = setup();
  await thread.carrierEvent(order(), 'delayed');
  assert.deepEqual(events.map((e) => e.type), ['delayed', 'risk_flagged', 'approval_requested']);
  assert.equal(approvals.length, 1);
});
test('approving the notice tells the client; rejecting does not', async () => {
  const { thread, events, approvals } = setup();
  await thread.carrierEvent(order(), 'delayed');
  await thread.resume({ ...approvals[0], approval: 'approved', actor: 'supervisor' });
  assert.deepEqual(events.slice(-2).map((e) => e.type), ['approved', 'client_notified']);
});
test('a delay for an ordinary client notifies without approval', async () => {
  const { thread, events } = setup();
  await thread.carrierEvent(order({ account_tier: 'Tier 3', account_status: 'active' }), 'delayed');
  assert.ok(events.some((e) => e.type === 'client_notified'));
});
```

  `order()` builds `{ id: 1, client_id: 'C190', account_tier: 'Tier 1', account_status: 'threatening_to_leave', sla: 1, warehouse_id: 'W3', distance_miles: 140, commitment_type: 'same_day', received_ts: '2026-10-27 10:15', wave: 2, carrier_id: 'D' }`.

- [ ] **Step 2:** Run. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `thread.js`.**
  - `release` converts the row to the agent shape `{ delivery_id: ref, received_ts, commitment_type, fulfilment_warehouse_id: warehouse_id, sla, account_status, account_tier, carrier_id, distance_miles, cutoff_breach: 0, address_incomplete: 0, stock_miss: 0 }`.
  - Wave: `planWaves([o], settings).get(ref)` (append `wave_assigned` with `{ wave, rule }`).
  - Carrier: `allocateCarriers([o], { model: world.model, limits: world.limits, rates: world.rates, settings, isFriday: false }).assignments.get(ref)` (append `carrier_selected` with `{ carrier_id, rule, extraCost }`).
  - Then `tracking_sent` with `{ channel: 'SMS (demo)', url: `/track/${row.tracking_token}` }`.
  - `carrierEvent('delayed')`: append `delayed`, then `risk_flagged` `{ reason: 'Carrier reported a delay of ~1 day' }`. If `needsClientNotice(o)`, append `approval_requested` via `store.requestApproval`; otherwise draft and notify. The draft comes from `claude.explain({ rule: TEMPLATE }, ctx)` when available, else `TEMPLATE`, and the event detail records `source`.
- [ ] **Step 4: `events.js`** with the DDL from the spec §4.3. **`routes/orders.js`** implements the spec §4.3 route table.
  - `POST /orders` calls `container.ingest.api('C190' or body.client_id, [order])`, then sets `demo = true` and `tracking_token = newToken()` on each created order and appends `received` plus `held` / `released` from its status.
  - `fix-address` calls `pipeline.reprocess(id, { ship_to })`; if it's no longer held, it appends `client_fixed`, `released` and calls `thread.release`.
  - `GET /track/:token` returns `{ ref, status, commitment_type, promised_date, carrier_id, banner, events: [{ ts, type, label }] }` with no internal fields.
  - `POST /demo/reset` runs `DELETE FROM agent_decisions WHERE run_id='thread'; DELETE FROM inbound_orders WHERE demo` (events cascade).
- [ ] **Step 5: Pipeline.** `run()` and `reprocess()` don't append events themselves. `routes/orders.js` appends them for portal orders, keeping the pipeline and its tests unchanged.
- [ ] **Step 6: Approvals.** `POST /agents/approvals/:id` accepts `actor` from the body (default `'manager'`). When `row.run_id === 'thread'` and the decision changed, it calls `thread.resume(row)`.
- [ ] **Step 7: `index.js`.** `await ensureOrderEventsTable()` at startup, mount `orders`, and extend `OPEN` to `/^\/api\/(health$|auth\/|v1\/|track\/)/`.
- [ ] **Step 8:** Tests pass. Manual check with `curl` against the local server: POST an order with a missing ZIP, fix it, and see the timeline.
- [ ] **Step 9:** Commit `feat(orders): shared order event log and golden-thread runner` and push.

### Task 7: Web routes, Timeline and the tracking page

**Files:** `web/src/main.jsx`; new `web/src/demo/persona.js`, `Timeline.jsx`, `Track.jsx`, `demo.css` (imported by the demo pages only).

- [ ] **Step 1: `main.jsx`.**

```jsx
<BrowserRouter>
  <Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/portal" element={<Portal />} />
    <Route path="/ops" element={<Ops />} />
    <Route path="/track/:token" element={<Track />} />
    <Route path="*" element={<App />} />
  </Routes>
</BrowserRouter>
```

- [ ] **Step 2: `persona.js`.**
  - `PERSONAS = { client: { label: 'Customer', account: 'orders@client190.demo', home: '/portal', client_id: 'C190' }, ops: { label: 'Halcyon Ops', account: 'supervisor.w3@halcyon.demo', home: '/ops' }, analyst: { label: 'Analyst / Judge', account: 'judge@halcyon.demo', home: '/' } }`
  - `getPersona()` / `setPersona(key)` use `sessionStorage` (per tab).
  - `usePoll(path, ms = 3000)` re-fetches via `api()`.
- [ ] **Step 3: `Timeline.jsx`.** Renders `events` as `.ops-event` rows: time, a label from `LABELS[type]`, actor, and a detail line. It takes `audience = 'internal' | 'public'`.
- [ ] **Step 4: `Track.jsx`.** Phone-width card:
  - status chip row (Received → Released → On the way → Delivered)
  - promised date and carrier
  - a `callout` delay banner when `banner`
  - a "Fix address" inline form when status is held
  - an SMS preview card labelled "Demo: not sent"
  - 👍/👎 after delivery (posts a `rated` event)
  - `usePoll('/track/' + token)`
- [ ] **Step 5:** `npm --prefix web run build` succeeds. Open `/track/<token>` from Task 6's curl order and check it renders and updates when the sim endpoint is called.
- [ ] **Step 6:** Commit `feat(web): demo routes, order timeline and public tracking page` and push.

### Task 8: Client portal

**Files:** new `web/src/demo/Portal.jsx`.

- [ ] **Step 1: New order form** (service, SKU, quantity, name, street, city, state, ZIP).
  - Shows a demo clock "Tue 27 Oct, 10:15 (demo time)".
  - Live promise text from the same rule: "After 08:00: same-day only via the 13:00 second wave if there's room, otherwise next-day."
  - Submit → `POST /api/orders` with `received_at: '2026-10-27T10:15'`.
- [ ] **Step 2: Inbox / My orders.** `usePoll('/orders?client=C190')`; each order shows status chips, a risk badge (`RiskBadge`), the latest message, an inline fix-address form when held, and `<Timeline audience="public">`.
- [ ] **Step 3:** Build passes. Manual check: place an order with no ZIP → held → fix → released.
- [ ] **Step 4:** Commit `feat(web): client portal (new order, inbox, timeline)` and push.

### Task 9: Ops console, persona login, reset, e2e

**Files:** new `web/src/demo/Login.jsx`, `web/src/demo/Ops.jsx`, `e2e/demo.spec.js`.

- [ ] **Step 1: `Login.jsx`.** Three cards with prefilled account and password fields, plus a badge "Demo accounts, no real authentication". Clicking calls `setPersona`, then `navigate(home)`.
- [ ] **Step 2: `Ops.jsx`.**
  - Demo orders table (`usePoll('/orders')`), with the selected order's `<Timeline>`.
  - Pending approvals (`/agents/approvals?runId=thread&approval=pending`) with Approve/Reject buttons that post `actor: 'supervisor'`.
  - "Simulate carrier: shipped / delayed / delivered" buttons.
  - A "Reset demo" button.
  - An "On-time today" KPI (delivered without delay / delivered).
  - Links to Operations day and Inbound gateway.
- [ ] **Step 3: `e2e/demo.spec.js`.**
  - login as Client → place a same-day order with no ZIP → see Held
  - fix the ZIP → see "13:00 second wave"
  - (API) simulate delayed → login as Ops in a second page → approve
  - client inbox shows the notice
  - simulate delivered → the track page shows Delivered
  - reset → the order list is empty
- [ ] **Step 4:** Run `npm --prefix server test && npm run test:e2e`. Expected: all pass, including the existing 17 tests.
- [ ] **Step 5:** Commit `feat(web): persona login, ops console, demo reset and end-to-end test` and push.
