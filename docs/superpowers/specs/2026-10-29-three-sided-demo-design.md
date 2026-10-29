# Halcyon three-sided demo: design

Date: 2026-10-29 · Status: draft for review · Branch: `Mohit-Evoke`

## 1. Goal

Turn the console from an analysis report into a product people can use, in two parts:

- **Part A.** Fix the review findings so every number on screen agrees with the data and with every other screen.
- **Part B.** Build a three-sided, end-to-end demo. One order travels from a **customer** (client portal) through
  **Halcyon** (gateway, agents, approvals) to the **end user** (public tracking page). All three views read one
  shared order event log.

Principle: **one door in, one event log, many views.** The portal is another gateway channel, next to email, EDI,
API and file drop.

Constraints:

| Topic | Decision |
|---|---|
| Existing screens | The 14 screens and their analysis numbers stay as they are, apart from the Part A fixes |
| Auth, email, SMS | None real. Everything is simulated and labelled "demo" |
| Data | Hackathon data plus synthetic data; clients C001–C280 only |
| AI | Must work offline: rules fallback, with the reason shown |
| Hosting | Current Azure setup (App Service + Postgres), no new paid services |
| Style | Reuse existing components and `index.css` tokens |

## 2. Facts the design rests on (checked against code and data)

- **Two order worlds.** The agents (`server/src/agents/`) run only on historical `deliveries` and test datasets.
  The gateway writes `inbound_orders`. No agent sees a gateway order, and approving a decision only re-runs the
  simulated day (`routes/agents.js:110`, actor hard-coded to `'manager'`).
- **The agents are pure functions** (`intakeDecide`, `planWaves`, `allocateCarriers`, `watch`), so they can be
  called on a single order without the simulator.
- **No real routes in the web app.** All screens render on one scrolling page (`App.jsx:60-111`).
- **No migrations.** New tables use the `ensure*Table` pattern at startup (`index.js:57-58`).
- **Demo client.** C190 "Client 190": Tier 1, SLA clause, `threatening_to_leave`, Southeast. Nearest warehouse **W3**.
- **The carrier cost cap never fires with default settings.** Rates are per-carrier averages (A 16.69, B 16.07,
  C 17.80, D 13.53, E 14.23, F 12.52). The largest extra cost is about $5.28 against a $6 cap, and Tier 1 / same-day
  orders may use only A/B/C. So the demo's approval moment uses the Watchtower rule instead: notifying a Tier 1 or
  at-risk client needs approval.

## 3. Part A: fixes

| # | Fix | Where | Effort | Priority |
|---|---|---|---|---|
| A1 | **Routing reframe.** Split `residual` into `route_detour` (actual/planned km > 1.2) and `unexplained`. Add a late vs on-time detour panel (clean orders: 18.4% vs 8.3% mean). Copy: "Route execution (detours > 20%) is linked to 6–10% of lateness (832 detour-only, +1.7 pts; 1,354 including slow-carrier orders, +2.8 pts). It is measured after the trip, so it's a correlate. Scope the vendor PoC down to driver route adherence; it doesn't justify $680K as scoped." | `db/schema.sql` view, `routes/agents.js:135`, `routes/overview.js:52`, StartHere, WhyLate, Decision, Known vs assumed, README | M | Must |
| A2 | **AI health.** `claude.probe()` with a cached status (`ok / not_configured / auth / not_found / timeout / error`) and `lastError` recorded on every caught failure. `GET /api/health/ai` (never returns the key). Operations day shows "AI offline: rules running (reason: …)". Plus an ops step: set `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_RESOURCE` and `CLAUDE_MODEL` (the real deployment name) as Azure app settings. | `agents/claude.js`, `liveDay.js:286`, `OperationsDay.jsx:136`, `index.js` | S–M | Must |
| A3 | **Test pack in production.** Generate test files at Docker build time (both generators are deterministic). Seed the live week in-process at startup when the ingest tables are empty (`SEED_DEMO_WEEK=1`), plus an admin button. Store the report in the DB, because the container filesystem is ephemeral. | `Dockerfile`, `server/scripts/seed-demo-week.mjs`, `start.sh`, `routes/ingest.js:146` | S + M | Must |
| A4a | **Unit-first addresses.** Treat a street-like "Deliver to" value as a street, join the middle parts in the one-line form, move a leading unit to the end, strip the unit before the house-number test. 4 regression tests. | `rules.js:49-61,79`, `validate.js:31`, `normalize.js` | S–M | Nice |
| A4b | **No raw `null`** in anomaly text: skip rarity checks when the value is null. | `quality/ClientProfiler.js:47-52` | S | Must |
| A5 | **Consistent numbers.** "~$0.9M net" (computed). "94% have a cause other than route planning; 67% go wrong before the truck leaves." One stock definition (6,009 "nearest had no stock"; label the 6,700 as "shipped from a farther warehouse"), with training and dataset features aligned. Label 91.3% (six-month rules replay) vs 92.7% (September ML backtest). Name "overall estimate within 0.1 pt" vs "per-band error 0.9%". Short chart labels. | StartHere, AiModel, SixMonths, `ml/repository.js:10`, `agents/datasets.js:75` | S each | Must: $, 94%, stock. Nice: the rest |
| A6 | **One promise rule.** A shared `promiseDelivery` in `rules.js`: before 08:00 → wave 1. Same-day before `secondWaveAt` with wave-2 room at the warehouse → keep same-day on the 13:00 wave. Otherwise → re-promise next-day. The gateway works out the warehouse first and keeps a wave-2 ledger. `planWaves` and `ClientProfiler.impossible_promise` use the same rule. | `rules.js:94`, `ingest/pipeline.js:110-139`, `agents/wave.js`, `ClientProfiler.js:42` | M | Must (the demo depends on it) |
| A7 | **450 out-of-order records.** Add `f_timeline_bad` to the view, exclude them from training and the backtest, footnote the headline. | `schema.sql`, `ml/repository.js`, `agents/repository.js` | S | Nice |

## 4. Part B: three-sided demo

### 4.1 Demo experience

**Login.** A "Sign in to Halcyon — demo" page with one-click cards. The fields are prefilled, and a badge says
"Demo accounts, no real authentication".

| Persona | Account | Lands on | Sees |
|---|---|---|---|
| Customer | Client 190, `orders@client190.demo` | Client portal | Portal only |
| Halcyon Ops | Supervisor, W3 Southeast | Ops console | Orders, approvals, timeline, plus Operations day and Inbound gateway |
| Analyst / Judge | Full view | Start here | Today's 14-screen story, unchanged |

The end user doesn't log in. They get a tracking link (shown as an SMS preview card and a QR code).

The persona lives in **sessionStorage (per tab)**, so three tabs can hold three personas at once. The header shows the
persona and a "Switch" link.

**Storyboard (about 4 minutes, three tabs side by side).** The tracking tab sits in a phone-width window.

| # | Customer | Halcyon Ops | End user | Events |
|---|---|---|---|---|
| 1 | Places a same-day order at 10:15 with the ZIP missing. The live promise check explains the 13:00 wave rule. | Order appears: Held, ZIP missing | — | `received`, `held` |
| 2 | Inbox: "Your order is missing a ZIP code" (Claude draft, or a template). Fixes it inline. | Released | — | `client_notified`, `client_fixed`, `released` |
| 3 | Confirmed: same-day, 13:00 wave | Wave Planner → W3 13:00 wave. Carrier agent → B ("Tier 1 + same-day: A/B/C only; B lowest expected cost") | SMS preview with the tracking link | `wave_assigned`, `carrier_selected`, `tracking_sent` |
| 4 | — | "Simulate carrier: delayed". Watchtower flags it and drafts a notice. C190 is Tier 1 and at risk, so the notice needs approval. Supervisor approves. | Delay banner | `delayed`, `risk_flagged`, `approval_requested`, `approved` |
| 5 | The same notice in the inbox | — | "Running ~1 day late, new ETA …" | `client_notified` |
| 6 | Delivered (green) | Timeline complete, KPI ticks | Delivered ✓, thumbs up/down | `delivered` |
| 7 | — | Reset demo | — | demo rows cleared |

The demo clock is fixed at 10:15 on a weekday, so the 13:00-wave rule applies every time.

### 4.2 Real vs simulated

| Real (our code) | Simulated (labelled "demo") |
|---|---|
| Gateway validation, hold, re-validation after the fix | Login |
| Shared promise rule, Wave Planner, carrier choice, Watchtower rule | Carrier "delayed" and "delivered" events (buttons) |
| Approval queue, event log | SMS and email (preview cards only) |
| Claude drafting, with a rules fallback and the reason shown | Demo clock |

### 4.3 Backend

**Schema** (added at startup with `IF NOT EXISTS`, never through `load.sh`):

```sql
CREATE TABLE IF NOT EXISTS order_events (
  id         serial PRIMARY KEY,
  order_id   int NOT NULL REFERENCES inbound_orders(id) ON DELETE CASCADE,
  ts         timestamp NOT NULL DEFAULT now(),
  actor      text NOT NULL,   -- client | intake_agent | wave_planner | carrier_agent | watchtower | supervisor | carrier | recipient | system
  type       text NOT NULL,   -- received | auto_fixed | held | client_notified | client_fixed | released | wave_assigned |
                              -- carrier_selected | tracking_sent | delayed | risk_flagged | approval_requested | approved |
                              -- rejected | shipped | delivered | rated
  detail     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS order_events_order_ts ON order_events (order_id, ts);
ALTER TABLE inbound_orders ADD COLUMN IF NOT EXISTS tracking_token text UNIQUE;
ALTER TABLE inbound_orders ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
```

**Modules:**

- `server/src/orders/events.js`: `ensureOrderEventsTable`, `appendEvent(orderId, actor, type, detail)`,
  `timeline(orderId)`, `byToken(token)`.
- `server/src/orders/goldenThread.js`: runs one gateway order through the agents' pure functions (shared promise
  rule → `planWaves` → `allocateCarriers` → `watch`), writing an event after each step. When a step needs approval,
  it inserts a real `pending` row in `agent_decisions` (key `thread:<order_id>:<step>`) and stops. Approving resumes
  the run. It doesn't touch the simulator, `LiveDay` or the analysis tables.
- `ingest/pipeline.js`: one `appendEvent` per outcome (received, auto_fixed, held, released). The decision logic is
  unchanged.

**Routes** (`server/src/routes/orders.js`, all behind `SITE_PASSWORD` except tracking):

| Route | Purpose |
|---|---|
| `POST /api/orders` | Portal order → `ingest.api` with `demo: true` |
| `GET /api/orders?client=` | A client's demo orders with their latest status |
| `GET /api/orders/:id/timeline` | Ordered events |
| `POST /api/orders/:id/fix-address` | Re-validates through `pipeline.reprocess`; if released, starts the golden thread |
| `POST /api/orders/:id/notify` | Claude draft (template fallback) → `client_notified` event + `notifications` row |
| `POST /api/sim/carrier-event` | `{order_id, type: shipped\|delayed\|delivered}`; `delayed` triggers the Watchtower step |
| `POST /api/demo/reset` | Deletes `demo = true` orders (events cascade) and their thread decisions only |
| `GET /api/track/:token` | **Open.** Public view: status, ETA range, carrier, banner, events without internal detail |
| `POST /api/agents/approvals/:id` | Existing; takes the real actor from the request and resumes a thread decision |

`index.js`: add `^/api/track/` to the open paths.

### 4.4 Frontend

- `App.jsx`: add real `<Routes>`. `/` keeps today's scroll story exactly as it is, with or without a persona, so
  existing links and e2e tests keep working. New routes are `/login`, `/portal/*`, `/ops` and `/track/:token`.
  The portal sends the demo clock time (10:15) as the order's received time.
- `components/Timeline.jsx`: a reusable order timeline built from the `.ops-event` styles. All three views use it.
- `pages/Login.jsx`: three persona cards; writes the persona to sessionStorage.
- `portal/NewOrder.jsx`: service, item, quantity and address, with a live promise check against the shared rule.
- `portal/Inbox.jsx`: messages (with an inline fix-address form) plus each order's status chips and timeline.
- `pages/OpsConsole.jsx`: demo orders, pending thread approvals (Approve / Reject), the timeline, simulate buttons,
  Reset demo, and a KPI ("on-time today").
- `pages/Track.jsx`: mobile-first status, ETA range, delay banner, fix-address button, SMS preview card, rating, QR code.
- Polling every 3 s on the timeline and status endpoints. No SSE.

### 4.5 Reliability on stage

| Risk | Mitigation |
|---|---|
| AI slow or offline | Each Claude step has a template fallback inside the timeout and shows "rules mode (reason: …)". A "force rules mode" toggle is available. |
| Shared live-day run | The golden thread is per order and independent of `LiveDay`. |
| Azure DB without migrations | Only `IF NOT EXISTS` DDL at startup. |
| No e2e gate in deploy | Run the golden-thread Playwright test locally before each push; click through production after each deploy. |
| Conflicts with ongoing `main` work | Small commits on `Mohit-Evoke`, regular PRs; tell Shivam which files are touched (`App.jsx`, `pipeline.js`, `rules.js`, `routes/agents.js`). |
| Analysis numbers drift | The thread writes only to new tables and demo rows. The existing unit and e2e tests must still pass. |

## 5. Scope for 1–2 days

**Must-have**

- Part A: A1, A2, A3, A4b, A5 ($, 94%, stock), A6.
- Part B: event log, golden-thread runner, timeline, tracking page, portal (new order + inbox), ops console, 3 personas,
  simulated carrier events, demo reset.

**Nice-to-have:** A4a, A7, the remaining A5 labels, QR code, rating, notification bell, COO KPI animation, SSE, extra personas.

## 6. Build order (commit and push to `Mohit-Evoke` after each step)

1. Part A must-fixes (A6 first, because the thread uses it)
2. Event log + golden-thread runner + routes + timeline component
3. Tracking page
4. Client portal
5. Ops console + persona login
6. Simulated events, demo reset, polish

## 7. Testing

- **Unit tests** (`node --test`): shared promise rule (wave 2 with room, without room, after 13:00), golden-thread
  steps with a memory log (event order, approval stops, resume), `/track` hides internal detail, reset deletes demo
  rows only, the parser and null fixes.
- **One Playwright e2e test** for the full storyboard: login → order → hold → fix → wave → delay → approve → delivered → reset.
- **Existing suites must pass unchanged**, apart from tests whose expected copy changes with A1/A5.
