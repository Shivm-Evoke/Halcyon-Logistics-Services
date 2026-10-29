# Halcyon Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team of rule-plus-Claude agents that runs Halcyon's operation in a live simulated day and a six-month replay, lifting on-time from 71% to about 95%, presented as the app's new story.

**Architecture:** A deterministic simulation engine in `server/src/agents/` applies five agents' rules to real orders and scores each decided order with an outcome model measured on Halcyon's own history. Claude (on Azure AI Foundry) adds email reading, explanations, exception handling and the Ops Lead briefing in the live day only; approval limits are enforced in server code. The web app gets three new screens and a reordered story.

**Tech Stack:** Node 22, Express 5, PostgreSQL, `node:test`; React 19, Vite, Recharts; `@anthropic-ai/foundry-sdk` (Claude `claude-opus-5-5`); Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-agentic-operations-design.md`

## Global Constraints

- Model `claude-opus-5-5`; effort set explicitly: `medium` for the Ops Lead, `low` for per-decision explanations.
- Claude tools use `strict: true` and `tool_choice: { type: "auto" }`; never forced tool choice.
- Email extraction uses structured output (`output_config.format`), not prefill.
- Check `stop_reason` before reading content; register the SDK's client-side refusal fallback middleware.
- Foundry credentials only from environment variables; never in code, tests or the repo.
- Claude is called only by the live day; the replay makes no Claude calls; tests never call Foundry.
- Claude timeout 20 s; on timeout, error, refusal or schema-invalid output the rule decision stands and the reason reads "rules only".
- Approval limits are checked on the server before an action executes.
- Distance bands: `<300`, `300-800`, `800+` miles.
- Second pick wave default 11:30; carriers collect 14:00–18:00; first pick list 08:00 (`PICK_LIST_CUTOFF` in `server/src/rules.js`).
- Simulation is seeded: same settings and seed give identical results.
- Follow existing patterns: ES modules, `node:test` + `node:assert/strict`, routes as `Router()` modules mounted under `/api` in `server/src/index.js`, pages in `web/src/pages/*.jsx` registered in `NAV` in `web/src/App.jsx`, data via `useApi()` / `api()` from `web/src/api.js`, charts via `ResponsiveContainer` + `anim` from `web/src/components/motion.jsx`.
- Work on branch `feature/autopilot`; commit locally per task; never push (the user pushes; pushing `main` deploys to Azure).

## Review Focus

- A day with no orders, or a filter window with none: rates come back `null`, never `NaN`, and charts show the empty state.
- Claude slow, down, refusing, or returning JSON that fails the schema: the decision still happens with "rules only" and the live day keeps running.
- An approval clicked twice, or after it timed out: the second click is a no-op with a clear status, never a double action.
- Settings out of range (negative capacity, wave time before 08:00 or at/after 14:00, share above 1): the API answers 400 naming the field.
- Browser refresh or a second tab during the live day: the run lives on the server and the page resumes the same run id.

---

### Task 1: Outcome model

**Files:**
- Create: `server/src/agents/outcomes.js`
- Test: `server/test/agents-outcomes.test.js`

**Interfaces:**
- Consumes: rows shaped like `mlRepository.loadDeliveries()` (`carrier_id`, `distance_miles`, `commitment_type`, `cutoff_breach`, `address_incomplete`, `stock_miss`, `late`).
- Produces:
  - `distanceBand(miles: number) -> '<300' | '300-800' | '800+'`
  - `class OutcomeModel { static fromHistory(rows, { minCell = 30 } = {}); pOnTime(order) -> number; }` where `order` has `carrier_id, distance_miles, commitment_type, cutoff_breach, address_incomplete, stock_miss`.

- [ ] **Step 1: Write the failing tests**

```js
test('reproduces the recorded on-time rate when decisions are unchanged', () => {
  const m = OutcomeModel.fromHistory(rows);
  const mean = rows.reduce((s, r) => s + m.pOnTime(r), 0) / rows.length;
  assert.ok(Math.abs(mean - actualOnTime(rows)) < 0.002);
});
test('clean short-haul cells match history', () => {
  // fixture: 100 clean D <300 orders, 66 on time; 100 clean A <300, 95 on time
  assert.equal(m.pOnTime({ carrier_id: 'D', distance_miles: 120, commitment_type: 'standard', cutoff_breach: 0, address_incomplete: 0, stock_miss: 0 }), 0.66);
  assert.equal(m.pOnTime({ ...thatOrder, carrier_id: 'A' }), 0.95);
});
test('sparse cells back off to coarser cells instead of returning NaN', () => { /* cell with n < minCell returns the carrier x band rate */ });
test('distanceBand edges', () => { assert.equal(distanceBand(299), '<300'); assert.equal(distanceBand(300), '300-800'); assert.equal(distanceBand(800), '800+'); });
```

- [ ] **Step 2: Run** `npm --prefix server test` — expect FAIL (module not found).
- [ ] **Step 3: Implement `OutcomeModel`**: cell key = carrier × band × commitment × cutoff_breach × address_incomplete × stock_miss; value = on-time share. Backoff order when `n < minCell`: drop commitment → drop carrier (keep band and flags) → global flags-only rate.
- [ ] **Step 4: Run** `npm --prefix server test` — expect PASS. Also run the first test against the real database once (a temporary script, not committed) and confirm the mean is 0.710 ± 0.002.
- [ ] **Step 5: Commit** `feat(agents): outcome model measured on Halcyon history`.

---

### Task 2: Agent data, settings and validation

**Files:**
- Create: `server/src/agents/repository.js`, `server/src/agents/settings.js`
- Test: `server/test/agents-settings.test.js`

**Interfaces:**
- Produces:
  - `agentsRepository.loadOrders() -> rows` = `mlRepository.loadDeliveries()` fields plus `account_status`, `carrier_rate_usd`, `delivery_id`, `received_ts` (`'YYYY-MM-DD HH:MM'`).
  - `DEFAULT_SETTINGS` (exact values):
    ```js
    { seed: 42, secondWaveAt: '11:30', wave2CapacityPerWarehouse: 30, carrierHeadroom: 0.25,
      fridayPrebookShare: 0.3, addressFixRate: 0.8, intakeConfidenceMin: 0.8,
      stockMissThreshold: 0.2, transferLimitPerNight: 40, watchtowerRiskMin: 0.4,
      costCapUsd: 6, agents: { intake: true, wave: true, carrier: true, stock: true, watchtower: true } }
    ```
  - `validateSettings(input) -> { ok: true, settings } | { ok: false, field, message }` (merges over defaults).

- [ ] **Step 1: Write failing tests**: defaults pass; `secondWaveAt: '07:30'` → `{ ok:false, field:'secondWaveAt' }`; `'14:00'` → field `secondWaveAt`; `wave2CapacityPerWarehouse: -1` → field `wave2CapacityPerWarehouse`; `addressFixRate: 1.2` → field `addressFixRate`; unknown agent key ignored.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** both files; `loadOrders` joins `clients` for `account_status`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(agents): settings with validation and order loader`.

---

### Task 3: Intake agent (rules)

**Files:**
- Create: `server/src/agents/intake.js`
- Test: `server/test/agents-intake.test.js`

**Interfaces:**
- Consumes: `settings` (Task 2).
- Produces: `intakeDecide(order, settings, rand: () => number) -> { agent: 'intake', fixAddress: boolean, confidence: number, needsApproval: boolean, rule: string }`.

- [ ] **Step 1: Failing tests**: complete address → `fixAddress:false`, no approval; incomplete address with `rand()` below `addressFixRate` → `fixAddress:true`, `confidence >= intakeConfidenceMin`; above → `fixAddress:false`, `rule` names "client query"; incomplete Tier 1 order → `needsApproval:true`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; confidence = 0.9 when fixed, 0.5 otherwise.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(agents): intake agent rules`.

---

### Task 4: Wave Planner agent (rules)

**Files:**
- Create: `server/src/agents/wave.js`
- Test: `server/test/agents-wave.test.js`

**Interfaces:**
- Produces: `planWaves(dayOrders, settings) -> Map<delivery_id, { agent: 'wave', wave: 1 | 2 | 'next', needsApproval: boolean, rank: number|null, rule: string }>`.

- [ ] **Step 1: Failing tests**:
  - order received 07:59 → wave 1; 08:00–(secondWaveAt − 1 min) → candidates for wave 2; at or after `secondWaveAt` → `'next'`.
  - ranking: same-day before next-day before standard; ties by `sla` desc, then `account_status = 'threatening_to_leave'` first, then earliest received.
  - capacity: with 31 candidates at one warehouse and capacity 30, exactly 30 get wave 2 and the 31st is `'next'` with `rule` naming capacity.
  - standard orders received after 08:00 that are not promised for the next day are not moved to wave 2 (no benefit), `rule` "no benefit".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; warehouse key = `fulfilment_warehouse_id`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(agents): second pick wave planner`.

---

### Task 5: Stock agent (rules)

**Files:**
- Create: `server/src/agents/stock.js`
- Test: `server/test/agents-stock.test.js`

**Interfaces:**
- Produces: `class StockAgent { constructor(settings); observe(dayOrders): void; planTransfers(): { pairs: Set<'client|region'>, decisions: object[] }; }` — `planTransfers()` uses only orders observed before the day being planned (no look-ahead); each decision `{ agent:'stock', pair, missRate, needsApproval, rule }`.

- [ ] **Step 1: Failing tests**: a client|region with miss rate 0.3 over ≥ 10 observed orders is in `pairs`; 0.1 is not; nothing is planned from orders not yet observed; when more pairs qualify than `transferLimitPerNight`, the highest miss rates are chosen and the rest have `needsApproval:true`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(agents): stock pre-positioning agent`.

---

### Task 6: Carrier and Watchtower agents (rules)

**Files:**
- Create: `server/src/agents/carrier.js`, `server/src/agents/watchtower.js`
- Test: `server/test/agents-carrier.test.js`

**Interfaces:**
- Consumes: `OutcomeModel.pOnTime` (Task 1), `CarrierCapacity` (`server/src/ml/CarrierCapacity.js`: `fromHistory(rows, { headroom })`, `forDay(volume)`), `PENALTY_USD`, `REDELIVERY_USD` from `server/src/rules.js`.
- Produces:
  - `allocateCarriers(dayOrders, { model, limits, rates, settings, isFriday }) -> { assignments: Map<delivery_id, { agent:'carrier', carrier_id, expectedCost, extraCost, needsApproval, rule }>, usage: Record<string, number> }`
  - `watch(dayOrders, assignments, { model, limits, usage, settings }) -> Map<delivery_id, { agent:'watchtower', action: 'none'|'upgrade', carrier_id, notifyClient: boolean, needsApproval: boolean, rule }>`

- [ ] **Step 1: Failing tests**:
  - expected cost = rate + (1 − pOnTime) × (`PENALTY_USD` if `sla` else `REDELIVERY_USD`); the lowest is chosen when capacity allows.
  - same-day and Tier 1 orders are only assigned A, B or C.
  - usage never exceeds limits; when A–C are full, an order gets the best remaining carrier and `rule` names capacity.
  - on Fridays A–C limits rise by `fridayPrebookShare`.
  - `extraCost` (over the cheapest carrier's rate) above `costCapUsd` → `needsApproval:true`.
  - Watchtower: order with `1 − pOnTime ≥ watchtowerRiskMin` upgrades to the lowest-risk carrier with spare capacity; Tier 1 or threatening-to-leave → `notifyClient:true, needsApproval:true`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; process orders in descending regret (cost gap between best and second-best carrier), as `NextBestAction.allocate` does.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(agents): carrier allocation and watchtower`.

---

### Task 7: Simulation engine and six-month replay

**Files:**
- Create: `server/src/agents/simulator.js`
- Test: `server/test/agents-simulator.test.js`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `simulateDay(dayOrders, ctx) -> { decided: object[], decisions: object[] }` — applies agents in order intake → stock (pairs from ctx) → wave → carrier → watchtower; sets on each decided order `address_incomplete`, `stock_miss` (and `distance_miles` from nearest warehouse via `ctx.distances`), `cutoff_breach` (0 when wave 1 or 2), `carrier_id`, then `pOnTime`. Decisions with `needsApproval` are applied in the replay only when `ctx.autoApprove` is true (default true for the replay; the live day passes false).
  - `runReplay(orders, { settings, distances, carriers, history }) -> { overall: { actual, agents }, weekly: [{ week, actual, agents }], waterfall: [{ agent, onTime }], money: { extraCarrierUsd, penaltiesSavedUsd, redeliverySavedUsd, csHoursSaved, netUsd }, accounts: [{ client_id, client_name, actual, agents }] }`
  - Waterfall: baseline, then agents switched on cumulatively in the order intake, wave, stock, carrier, watchtower.

- [ ] **Step 1: Failing tests** (fixture ~200 orders over 3 days):
  - all agents off → `overall.agents` equals `overall.actual` within 0.002.
  - same settings twice → deep-equal results; different `seed` → may differ.
  - day with no orders → no `NaN` anywhere (`weekly` rate `null`).
  - waterfall last value equals `overall.agents`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; random draws from a seeded PRNG (mulberry32 on `settings.seed`), one stream per day keyed by date so days are independent. Money: penalties saved = (late orders avoided among `sla` orders) × `PENALTY_USD`; redelivery saved = late avoided × `REDELIVERY_USD`; CS hours saved = late avoided × (461 h / weekly late count in the time study's week) — state the formula in a code comment.
- [ ] **Step 4: Run** — PASS. Then run the real replay once (temporary script): expect `overall.actual` 0.710 and `overall.agents` ≥ 0.93; record the numbers in the commit message.
- [ ] **Step 5: Commit** `feat(agents): simulation engine and six-month replay`.

---

### Task 8: Decision log, approvals and API

**Files:**
- Modify: `db/schema.sql` (append table), `server/src/index.js` (mount router)
- Create: `server/src/agents/log.js`, `server/src/routes/agents.js`
- Test: `server/test/agents-approvals.test.js`

**Interfaces:**
- Produces:
  - table `agent_decisions (id serial pk, run_id text, sim_ts text, agent text, delivery_id int, decision jsonb, rule text, reason text, reason_source text check in ('claude','rules only'), approval text check in ('auto','pending','approved','rejected','expired'), actor text, created_at timestamptz default now())`
  - `decisionLog = { insert(rows), list({ runId, agent, approval, limit }), setApproval(id, approval, actor) -> { changed: boolean, row } }` — `setApproval` only changes a row whose approval is `'pending'`.
  - Routes: `GET /api/agents/settings`, `POST /api/agents/replay` (body = settings → `runReplay` result; 400 `{ error, field }` on invalid settings; result cached per settings JSON), `GET /api/agents/approvals?runId=`, `POST /api/agents/approvals/:id` body `{ approval: 'approved'|'rejected' }`.

- [ ] **Step 1: Failing tests** (in-memory fake of `decisionLog` behind the same interface): approving a pending row returns `changed:true`; approving it again returns `changed:false` and the row unchanged; approving an `'expired'` row returns `changed:false`; an executor given a decision with `needsApproval` and no approval does not apply it.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; add the table to `db/schema.sql` so `db/load.sh` creates it.
- [ ] **Step 4: Run** `npm --prefix server test` — PASS; `bash db/load.sh` then `curl -X POST localhost:4000/api/agents/replay -H 'content-type: application/json' -d '{}'` returns `overall`; `-d '{"secondWaveAt":"07:00"}'` returns 400 with `field: "secondWaveAt"`.
- [ ] **Step 5: Commit** `feat(agents): decision log, approvals and replay API`.

---

### Task 9: Claude client (Foundry)

**Files:**
- Create: `server/src/agents/claude.js`
- Modify: `server/package.json` (add `@anthropic-ai/foundry-sdk`)
- Test: `server/test/agents-claude.test.js`

**Interfaces:**
- Produces: `createClaude({ client } = {}) -> { available: boolean, explain(decision, context) -> Promise<{ text, source }>, extractEmail(rawText) -> Promise<{ order|null, confidence, source }>, briefing(state, tools) -> Promise<{ text, toolCalls, source }> }`. `source` is `'claude'` or `'rules only'`. With no `client` passed, it builds an `AnthropicFoundry` client from environment variables (`ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_RESOURCE`; confirm exact names in the SDK README before writing) and model from `CLAUDE_MODEL` (default `claude-opus-5-5`); with neither set, `available:false` and every call returns `source: 'rules only'`.
  - `extractEmail` schema = the normalised order fields used by `server/src/ingest/normalize.js` plus `confidence` (0–1).
  - `briefing` runs a manual tool loop over strict tools `get_state`, `run_agent` (`{ agent }`: re-runs one agent's rules on the current state and returns its decisions), `list_pending_approvals`, `explain_decision`; max 6 iterations. Conflicts it reports (e.g. Wave 2 orders the Carrier agent could not place) are surfaced in the briefing text; the rules' decisions stand.
- Modify also: `server/src/ingest/channels/email.js` — when the rule-based parser marks an email `unparseable`, call `claude.extractEmail(raw)`; use its order only when `confidence >= settings.intakeConfidenceMin`, then send it through the existing validator as usual. Test: fake client returning a confident order turns an unparseable email into a validated order; a low-confidence answer leaves it unparseable.

- [ ] **Step 1: Failing tests** with a fake client object exposing `messages.create`: a normal text response → `source:'claude'`; fake that rejects after 25 s (use fake timers) → `'rules only'`; `stop_reason: 'refusal'` → `'rules only'`; `extractEmail` with schema-invalid JSON → `order:null, source:'rules only'`; no env and no client → `available:false`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; system prompts are constants (stable for prompt caching); per-call timeout 20 000 ms.
- [ ] **Step 4: Run** — PASS. With real env vars set locally, a one-off `node -e` call of `explain()` prints a sentence (manual check; not a test).
- [ ] **Step 5: Commit** `feat(agents): Claude on Foundry with rules-only fallback`.

---

### Task 10: Live operations day

**Files:**
- Create: `server/src/agents/liveDay.js`, `server/data/recorded-day.json` (generated)
- Modify: `server/src/routes/agents.js`
- Test: `server/test/agents-liveday.test.js`

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces:
  - `pickDemoDay(orders) -> 'YYYY-MM-DD'` = the September 2026 Friday with the lowest recorded on-time rate.
  - `class LiveDay { constructor({ day, orders, settings, claude, log, mode: 'live'|'recorded' }); runId; advance(minutes) -> events[]; state() -> { runId, simTime, mode, counters: { actual, agents }, lanes: Record<agent, events[]>, approvals, briefings }; }` — sim time runs 00:00 → 24:00; at each 30-minute boundary it runs the agents on orders received so far and the Ops Lead briefing; pending approvals older than 120 sim-minutes become `'expired'`.
  - Routes: `POST /api/agents/live` body `{ mode }` → `{ runId }` (one active run; starting again replaces it); `POST /api/agents/live/:runId/advance` body `{ minutes }`; `GET /api/agents/live/:runId` → `state()`; `GET /api/agents/live/current` → `{ runId }` or 404 when no run exists; `POST /api/agents/live/:runId/record` saves Claude responses to `server/data/recorded-day.json`.
  - Recorded mode replays reasons from that file by decision key and makes no network calls.

- [ ] **Step 1: Failing tests** (fake Claude, fixture day): advancing to 08:00 yields wave-1 events only; to 11:30 yields wave-2 events; `counters.agents` is non-decreasing in decided orders and equals `simulateDay` for the full day at 24:00; `state()` called twice returns the same `runId`; an approval pending for 121 sim-minutes is `'expired'`; recorded mode with a fake that throws still returns reasons from the file.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS; with Foundry configured, run the day once and `POST …/record` to generate `server/data/recorded-day.json`; commit it.
- [ ] **Step 5: Commit** `feat(agents): live operations day with recorded mode`.

---

### Task 11: Operations day screen

**Files:**
- Create: `web/src/pages/OperationsDay.jsx`
- Modify: `web/src/index.css` (lane styles only)

**Interfaces:**
- Consumes: live routes (Task 10), approvals route (Task 8).
- Produces: default export `OperationsDay` page; element ids `#ops-clock`, `#ops-counter-actual`, `#ops-counter-agents`, `.ops-lane[data-agent]`, `.ops-approval button[data-approve]`, `.ops-approval button[data-reject]`, `#ops-mode` (live/recorded).

- [ ] **Step 1:** Build controls: start (mode select), play/pause, speed (1, 2, 4 sim-hours per minute), jump buttons 08:00 / 11:30 / 14:00. Play calls `advance(30)` on an interval (1 sim-hour ≈ 20 s at speed 1). On mount, if `GET /api/agents/live/current` returns a run, resume it.
- [ ] **Step 2:** Two counters (actual vs with agents) using `CountUp`; five lanes plus an Ops Lead briefing panel; each event shows the decision, rule and reason with a "rules only" tag when `reason_source` is `'rules only'`; "AI offline: rules running" banner when every reason in the last tick is rules-only.
- [ ] **Step 3:** Approval queue with approve/reject; buttons disabled while the request is in flight; status shown from the server's answer (`changed:false` → "already decided").
- [ ] **Step 4: Verify** `npm --prefix web run build` and `npm --prefix web run lint` (no new warnings); open the page against a local API and run 08:00 → 14:00.
- [ ] **Step 5: Commit** `feat(web): operations day screen`.

---

### Task 12: Six months with agents screen

**Files:**
- Create: `web/src/pages/SixMonths.jsx`

**Interfaces:**
- Consumes: `POST /api/agents/replay` (Task 8).
- Produces: default export `SixMonths`; ids `#replay-overall`, `#replay-weekly`, `#replay-waterfall`, `#replay-settings`.

- [ ] **Step 1:** Headline KPIs: actual vs agents on-time, net savings, at-risk accounts recovered.
- [ ] **Step 2:** Weekly line chart (two series, one axis), uplift waterfall built by hand as bars (baseline → each agent → total), money table, at-risk accounts table.
- [ ] **Step 3:** Settings panel with the Task 2 fields and short assumption notes; "Re-run" posts settings; a 400 shows the message beside the named field.
- [ ] **Step 4: Verify** build and lint; re-run with `carrierHeadroom: 0` shows a lower agents line.
- [ ] **Step 5: Commit** `feat(web): six-month replay screen`.

---

### Task 13: Story restructure

**Files:**
- Create: `web/src/pages/WhyLate.jsx`, `web/src/pages/Agents.jsx`, `web/src/pages/Decision.jsx`
- Modify: `web/src/App.jsx` (NAV), `web/src/pages/StartHere.jsx`
- Delete from NAV (keep files): `Overview`, `Diagnosis`, `WhatIf`

**Interfaces:**
- Produces NAV order and paths: `/` Start here · `/why-late` Why we're late · `/operations-day` Operations day · `/six-months` Six months with agents · `/agents` Meet the agents · `/decision` The decision · appendix: `/ai-model`, `/data-quality`, `/accounts`, plus drill-downs `/inbound`, `/carriers`, `/inventory`, `/control-tower` linked from Meet the agents.

- [ ] **Step 1:** `WhyLate`: the five-cause table with the spec §2 figures (read live from existing endpoints where they exist, else from a new `GET /api/agents/causes` computed by SQL in `server/src/routes/agents.js`) and the routing evidence.
- [ ] **Step 2:** `Agents`: one card per agent (job, rules, limits from `GET /api/agents/settings`, last 5 decisions from the log) linking to its drill-down screen.
- [ ] **Step 3:** `Decision`: recommendation, numbers pulled from the replay, approvals leadership must give, rollout steps; `StartHere` updated to the new story.
- [ ] **Step 4: Verify** build, lint; scroll the whole story; every nav link lands on its screen.
- [ ] **Step 5: Commit** `feat(web): agent-led story order`.

---

### Task 14: End-to-end tests, docs and deployment settings

**Files:**
- Modify: `e2e/app.spec.js`, `README.md`, `Dockerfile` (if `server/data` needs copying), `render.yaml` (env var names), `.github/workflows/deploy.yml` (no secrets in file; document required app settings in README)

- [ ] **Step 1:** Update existing e2e tests whose screens moved; add: replay screen shows `#replay-overall` with two percentages; operations day in recorded mode reaches 14:00 and shows wave-2 events; approving one item changes its status and a second click shows "already decided"; invalid wave time shows the field error.
- [ ] **Step 2: Run** `npm test` — expect all unit and e2e tests to pass.
- [ ] **Step 3:** README: new story, agents, settings and assumptions, Foundry env vars, how to record the demo day; deployment: Azure App Service settings `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_RESOURCE`, `CLAUDE_MODEL`.
- [ ] **Step 4: Verify** `docker build .` succeeds and the container serves `/operations-day` in recorded mode with no Foundry variables set.
- [ ] **Step 5: Commit** `test: agent story e2e; docs: autopilot setup`.
