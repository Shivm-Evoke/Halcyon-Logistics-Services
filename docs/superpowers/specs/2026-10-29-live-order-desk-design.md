# Halcyon end to end: live order desk, four order channels, five-screen staff side

Date: 2026-10-29 · Deadline: finals demo (20 minutes + 10 minutes Q&A) · Branch: from `feature/customer-portal`

## Goal

One logistics service a judge can follow end to end: a customer sends orders by **email, EDI, API or the
portal form**; the **gateway** (middleware) checks them; the **five agents** act on each live order within the
manager's limits, with Claude's reasons; **staff** approve what is over a limit and move orders to delivered;
the **customer** watches tracking update. Each of the five measured causes of late deliveries is shown on one
live order ("PnC" example). The large-scale proof (worst Friday, six months, money) follows.

## The 20-minute demo this is built for

| Min | Screen | Shown |
|---|---|---|
| 0–2 | Staff · The problem | 71.0% on time vs the 94% benchmark; the five causes with counts and cost |
| 2–12 | Customer portal → Staff · Live operations | Five sample orders, one per cause and channel (table below); one approval; orders moved to delivered; customer tracking |
| 12–16 | Staff · Operations day | Worst Friday 63.7% → 90.6% on the clock, Claude briefings |
| 16–20 | Staff · Results | Six months 71.0% → 91.3%, ~$897K net, the decision |
| Q&A | Staff · Evidence (collapsed) | Carrier scorecard, Inventory placement, Test data |

### The five sample orders

| # | Channel | Cause | Expected outcome on Live operations |
|---|---|---|---|
| 1 | Email | Incomplete address | Gateway extracts the order (Claude if the parser cannot), Intake completes the address or holds it; a held order is fixed by the customer in the portal and released |
| 2 | EDI (X12 850) | Same-day order after the 08:00 cutoff | Wave Planner puts it in the 13:00 second wave and keeps it same-day (without the agents the gateway re-promises next-day) |
| 3 | API | Stock missing at the nearest warehouse | Stock agent: transfer to the nearest warehouse (or ship from the next one); promised date shown |
| 4 | Portal form | Tier 1 order whose default carrier is D | Carrier agent picks A/B/C; extra cost is over the $6 cap, so it waits in the approval queue; staff approve |
| 5 | API | High late risk before the 14:00 collection | Watchtower upgrades the carrier (or flags the client) with Claude's reason |

Each sample is a fixed file under `server/data/samples/` (`1-email.eml`, `2-edi.x12`, `3-api.json`,
`4-form.json`, `5-api.json`) for the demo customer's client, built so it triggers its cause against the history.

## Screens

**Public:** Home, Sign in (exist on the branch).

**Customer portal** (exists on the branch; changed):
- Dashboard, Shipments (unchanged).
- **Place orders**, four tabs: *Form* (exists), *Upload EDI* (an X12 850 file), *Send email* (paste or upload
  an .eml / text), *API* (base URL, docs link, and "Create API key" that shows a new secret once). Every tab
  has **Send a sample**, which sends that channel's sample(s) above. Orders sent from the portal always belong to
  the signed-in customer's client, whatever the file says.
- **Tracking** (Shipment page, changed): the stage timeline plus "What we did": each agent decision on this
  order in plain words (Claude's reason when available), the promised date, and what the customer must fix if held.

**Staff side: five entries, nothing else in the sidebar:**
1. **The problem**: today's "Why we're late" cut to the headline (71.0% vs 94%) and the five causes with
   counts and cost. One screen, no tabs.
2. **Live operations** (new; replaces Dispatch board and Inbound gateway in the sidebar): the ops clock; every
   live order (ref, client, channel, received time, stage, promised date, carrier, risk); per order the gateway
   checks and each agent's decision with its reason; the approval queue; buttons to move an order on; a compact
   "the five agents" strip with each agent's count of decisions today.
3. **Operations day**: unchanged.
4. **Results**: Six months plus the content of The decision below it.
5. **Evidence** (collapsed group, for Q&A): Carrier scorecard, Inventory placement, Test data.

Removed from the sidebar and the one-page story: Start here, Why we're late (replaced by The problem), Meet the
agents, The decision (merged), Inbound gateway, AI risk model, Data quality, Account health, Exceptions control
tower, Dispatch board. Their API routes stay; only the screens go. The one-page scroll keeps working over the
five entries.

## Live order desk (server)

New module `server/src/desk/` that runs the existing agents on live gateway orders.

**Ops clock.** The desk has a clock: a simulated date-time that runs at real speed from the moment staff set
it. Stored in table `desk_clock (id int primary key default 1, set_to timestamp, set_at timestamptz)`. Default
when unset: Friday 2026-09-25 09:15. Staff can set it (e.g. back to 07:30 before the demo) and press
**Advance** to the next event (08:00 wave 1, 13:00 wave 2, 14:00 collection, end of day). Every order the portal
sends gets `received_ts` = the ops clock now (samples carry no timestamp of their own).

**Which orders.** Live orders are `inbound_orders` with status accepted, corrected or held, created since the
clock was last set. Rejected and duplicate orders are not live. Each setting of the clock starts a new run
(`run_id = desk-<date>-<n>`).

**Mapping to the agents' order shape.** From the row and its `normalized` JSON: `delivery_id` = order ref
(`IN-000123`), `client_id`, `account_tier` (from clients), `commitment_type` as the customer asked (before any
gateway re-promise), `received_ts`, `destination_region`, `nearest_warehouse_id` = the gateway's warehouse,
`fulfilment_warehouse_id`, `distance_miles`, `address_incomplete` (1 when held for the address or corrected by
an address rule), `stock_miss` (the gateway's stock check), `carrier_id` = the gateway's carrier, and
`cutoff_breach` (same-day received after 08:00).

**Running the agents.** `deskRun(dayOrders, world, settings, approvals)` calls the existing `simulateDay` with
the history's `buildWorld` model and capacity, the day's Friday flag, the stock pairs the Stock agent learned
from the history, and the approvals recorded for the desk. It runs again whenever a live order arrives, is
fixed, or an approval changes, so wave capacity and carrier capacity are shared across the day's live orders.
Decisions go to the existing `agent_decisions` table with the current run's `run_id`, one row per
(agent, order) kept up to date (no duplicates on re-run). Decisions needing approval are `pending` until staff
decide; they expire after 120 simulated minutes, and then the safe option stands (as in the live day).

**Claude.** Each new decision is explained by `claude.explain` in the background (20 s timeout, rules-only
fallback). The reason is stored on the decision row and shown to staff and to the customer.

**Effect on the order.** After a run the desk writes what the agents decided onto the order: second wave keeps
`commitment_type = same_day` and the same-day promised date; a carrier change or upgrade updates `carrier_id`;
a stock transfer sets the fulfilment warehouse; an address fix clears the hold and releases the order. Each
change is a shipment event with a plain message ("Second pick wave at 13:00: still same-day").

**Gateway change.** With the desk on (`DESK=1`, default on), the gateway no longer re-promises a same-day order
received after 08:00; it marks `cutoff_breach` and leaves the decision to the Wave Planner. With the desk off
the gateway behaves as today (this is the "without agents" comparison).

**Stages.** Received → picked (at its wave: 08:00 or 13:00) → collected (14:00) → in transit → delivered (on
the promised date). **Advance** on the ops clock moves every live order whose time has come; staff can also move
one order with its button. Held orders stay on hold until fixed.

## API

Staff (`/api/desk/*`):
- `GET /desk` → `{ clock, orders: [{ ref, client, channel, received_ts, stage, promised_date, carrier_id, risk, status, checks, decisions: [{ agent, rule, reason, reason_source, approval, id }] }], approvals, counts }`
- `POST /desk/clock {set_to}` · `POST /desk/advance` (to the next event) · `POST /desk/orders/:ref/advance`
- Approvals reuse `POST /api/agents/approvals/:id` and trigger a desk re-run.

Customer (`/api/portal/*`, scoped to the session's client):
- `POST /portal/edi` (text body) · `POST /portal/email` (text body) → gateway with the client forced.
- `POST /portal/samples/:n` (n = 1–5) → sends that sample through its channel.
- `POST /portal/api-key` → creates or replaces the client's API secret; returns it once.
- `GET /portal/orders/:ref` gains `decisions` (agent, plain reason; no internal ids or costs).

## Sign-in

- Session lifetime 7 days; the cookie is renewed on use when less than half its life is left.
- `JWT_SECRET` is required in `server/.env` locally too (the server logs a warning when it is missing and any
  restart signs everyone out); `.env.example` lists it blank.

## Out of scope

Carrier portal, billing, webhooks, sign-up, password reset, outgoing emails. No change to the agents' rules,
the replay, Operations day or the history.

## Error handling

- A channel payload that fails to parse returns the gateway's existing errors to the customer on that tab.
- A desk run that throws leaves the orders as the gateway made them and logs the error; the screen shows
  "agents not run" on the affected orders.
- Claude unavailable: reasons show the rule, as elsewhere.

## Testing

- Unit: mapping a gateway order to the agent shape; each sample produces its expected decision
  (intake / wave 2 / stock / carrier pending approval / watchtower); approvals change the outcome and re-runs do
  not duplicate decisions; the ops clock and Advance move stages; the gateway keeps same-day with the desk on and
  re-promises with it off; session renewal.
- E2E: customer sends all five samples → staff see five orders with the expected agents → approve #4 → advance
  to end of day → customer sees delivered with "What we did"; sidebar shows exactly the five staff entries.

## Review focus

- A customer must never create or see orders for another client through EDI or email (sender in the file ignored).
- Re-running the desk is idempotent: same decisions, same events, no duplicates.
- Running the demo twice: setting the ops clock (e.g. back to 07:30) starts a new desk run
  (`run_id = desk-<date>-<n>`); only orders received after that moment are live, earlier ones stay in history
  untouched.
- The ops clock across midnight and a server restart (clock persists).
- Orders with no region or warehouse (held for address) are skipped by stock/carrier until fixed.
