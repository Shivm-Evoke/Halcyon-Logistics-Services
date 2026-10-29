# Halcyon Autopilot: agentic operations design

Date: 2026-10-29 · Status: draft for review · Repo: `~/Halcyon-Logistics-Services`

## 1. Goal

Present a **solution**, not only an analysis: a team of AI agents that runs Halcyon's daily operation and lifts on-time
delivery from **71% to about 95%**, shown live on stage and proven on the full six months of Halcyon's data. The demo
must make clear that the routing product leadership wants to buy would not fix the problem.

Constraints agreed:

| Topic | Decision |
|---|---|
| Proof | Both: a live "operations day" and a six-month replay |
| AI service | Claude on Microsoft Azure AI Foundry (`claude-opus-5-5`) |
| Autonomy | Guardrailed: agents act within limits; anything outside goes to a manager's approval queue |
| Approach | Fixed decision rules carry routine decisions and the replay; Claude handles reading, judgement and explanation |
| Time | Finals in 2–3 days |

## 2. Evidence the design rests on

All figures from the 48,340 deliveries (1 Apr – 25 Sep 2026). Baseline on-time 71.0%.

| # | Cause | Evidence | Orders hit |
|---|---|---|---|
| 1 | Weak carriers on easy routes | Clean orders under 300 miles: A 95.1%, B 94.9%, C 95.6%, E 83.2%, F 80.2%, **D 66.2%** on time. Same-day orders go to D/E/F 40.5% of the time. | ~15k on D/E/F |
| 2 | Friday overflow | 38.8% of Friday orders go to D (about 12% on other days); Friday on-time 66.7% | 11,175 Friday orders |
| 3 | 8 AM pick-list cutoff vs 14:00–18:00 collection | Same-day orders received 08:00–13:59: 39.0% on time; before 08:00: 74.0% | 4,826 orders, 2,944 late |
| 4 | Incomplete addresses | Email 27.8% incomplete vs 5% API/EDI; incomplete orders ~35% on time | 5,994 orders |
| 5 | Stock not at nearest warehouse | Ships from 1,237 miles on average (146 when stocked); 50.0% on time | 6,009 orders |
| — | Routing (leadership's theory) | Flat ~85% on time from 6 to 40 stops; actual route 1.10× planned on every route | — |

Cost: $872k SLA penalties and $477k redelivery in six months; 9 clients worth $14.2M a year threatening to leave;
customer success spends 461 of 720 hours a week (64%) on complaints.

Ceiling: with all causes fixed, orders behave like clean orders on carriers A–C, about **95%**. Going beyond needs the
Watchtower agent's in-transit interventions.

## 3. Architecture

```
            ┌──────────────────── Ops Lead (Claude) ────────────────────┐
            │ every 30 sim-min: call agents as tools, settle conflicts, │
            │ write the manager briefing                                 │
            └──┬─────────┬──────────┬───────────┬──────────┬────────────┘
           Intake   Wave Planner  Carrier     Stock     Watchtower
            │         │           │           │          │
            └─────────┴── existing engine (tools) ─┴──────┘
     validator · auto-fixes · risk model · carrier scoring · capacity simulator · inventory placement
                                   │
                         Decision log (PostgreSQL)
                                   │
              Operations day (live) · Six-month replay · Approval queue
```

New code lives in `server/src/agents/` (agents, rules, simulator, Claude client) with routes under `/api/agents/*`.
Existing services in `server/src/ml`, `server/src/ingest` and `server/src/rules.js` become the agents' tools; they are
reused, not rewritten.

### 3.1 Agents

Each agent exposes `decide(state, context)` (rules, deterministic) and optionally `reason(decision)` (Claude).

| Agent | Fixes | Rules | Claude | Needs approval when |
|---|---|---|---|---|
| Intake | #4 | Existing validator and auto-fixes for API/EDI/CSV | Extracts free-text emails into orders (structured output), repairs addresses with a confidence score, drafts a client query | Confidence below threshold, or a Tier 1 order would change |
| Wave Planner | #3 | Second pick wave at 11:30 (setting). Ranks post-08:00 orders: same-day, then SLA clause, at-risk account, risk score; fills to warehouse pick capacity | Handles manager "urgent" requests; explains what was left out | Wave would exceed capacity |
| Carrier | #1, #2 | Picks the carrier with the lowest expected cost (rate + P(late) × cost of late) within daily capacity per carrier; same-day and high-value orders restricted to A–C; Friday capacity pre-booked from Thursday | Explains trade-offs; resolves capacity clashes | Extra cost above the per-order cap |
| Stock | #5 | Nightly forecast of demand per client × region; proposes transfers before a shortfall (1-day lead time) | Summarises moves and reasons | Transfer above size limit |
| Watchtower | residual | Scores in-transit orders with the existing risk model; upgrades carrier or expedites above a risk threshold | Drafts proactive client messages | Message to a Tier 1 or at-risk client |
| Ops Lead | coordination | — | Runs each tick with the five agents as tools; resolves conflicts; writes the briefing | — |

### 3.2 Claude integration

- Client: Anthropic's Foundry SDK for TypeScript/JavaScript (`@anthropic-ai/foundry-sdk`, `AnthropicFoundry`); resource
  and key from environment variables, never in code or the repo. Exact constructor options are taken from the SDK
  documentation at build time.
- Model `claude-opus-5-5`; effort set explicitly (`medium` for the Ops Lead, `low` for per-decision explanations).
- Tool use: strict tool definitions (`strict: true`); `tool_choice` `auto` (forced tool choice is not supported on this
  model). Our own loop in Node; Anthropic's hosted Managed Agents are not available on Foundry.
- Email extraction: structured output (`output_config.format`) with a JSON schema matching the existing normalised order.
- Refusals: check `stop_reason` before reading content; register the SDK's client-side refusal fallback middleware
  (server-side fallbacks are not available on Foundry).
- Calls happen only in the live day (hundreds per run). The replay makes no Claude calls.
- Tests use a fake client; no test calls Foundry.

### 3.3 Simulation engine

One engine serves both the live day and the replay.

- **Input:** real orders (arrival time, channel, address status, client, destination, commitment) from `deliveries`.
- **Decisions:** the agents set intake fix, pick wave, fulfilment warehouse, carrier and in-transit intervention.
- **Outcome model:** P(on time) for each decided order comes from rates measured on Halcyon's own history, by carrier ×
  distance band × commitment, for clean orders, with penalties for an unfixed address or a non-local warehouse taken
  from the same history. Outcomes are drawn with a fixed seed so a run is repeatable.
- **Constraints (settings, with stated assumptions):** spare daily capacity of carriers A, B and C; warehouse pick
  capacity for the second wave; transfer lead time 1 day; approval limits.
- **Comparison:** every run reports actual (as recorded) against with-agents for the same orders.

### 3.4 Live operations day

- Day: the worst Friday in September 2026 by on-time (chosen by query at build time).
- Clock: about 1 sim-hour per 20 seconds; play, pause, speed, jump to 08:00 / 11:30 / 14:00.
- Streams: orders arriving; one lane per agent with decisions and Claude's reason; approval queue (approve / reject);
  Ops Lead briefings; actual vs with-agents on-time counters.
- Pending approvals wait for a decision; on timeout the action is not taken (logged as declined).
- **Recorded mode:** a stored run of real Claude responses for the same day, played back without network access, as
  the stage backup.

### 3.5 Six-month replay

Rules-only run over all 48,340 orders, day by day under the constraints. Shows:

- weekly on-time, actual vs with-agents;
- uplift waterfall: points added by each agent;
- money: extra carrier spend vs penalties, redelivery and customer success hours saved, net;
- the nine at-risk accounts: on-time before and after;
- the settings panel; changing a setting re-runs the replay (target: under 10 seconds).

## 4. Screens (story order)

| # | Screen | Status |
|---|---|---|
| 1 | Start here: one-minute story, five causes | Reworked |
| 2 | Why we're late: five causes with numbers; routing ruled out | Merges Overview + Diagnosis |
| 3 | Operations day (live) | New |
| 4 | Six months with agents | New, replaces What-if |
| 5 | Meet the agents: job, rules, limits, recent decisions; drill-downs to Inbound gateway (Intake), Carrier scorecard (Carrier), Inventory placement (Stock), Control tower (Watchtower) | Reuses existing screens |
| 6 | The decision: don't buy routing, run the agents; cost, approvals needed, rollout | New |
| — | Evidence appendix: AI risk model, Data quality, Account health | Kept |

Existing look and behaviour stay: continuous story scroll, light/dark, square design, chart animations.

## 5. Safety, failure handling, audit

- Approval limits are enforced on the server before an action executes; Claude's output is a proposal, never a bypass.
- Decision log table: run id, sim time, agent, order id, decision, rule applied, Claude reason, approval state, actor.
- Claude unavailable or slow (timeout 20 s): the agent keeps its rule decision, marks the reason "rules only", and the UI
  shows "AI offline: rules running".
- Claude output that fails schema validation is discarded and logged; the rule decision stands.

## 6. Testing

- Unit tests per agent's rules (ranking, capacity, carrier choice, thresholds).
- Simulator: same seed and settings give the same result; with all agents off the replay reproduces the recorded 71.0%.
- Approval gate: an action above a limit is never executed without approval.
- Claude client: fake client in tests; schema-invalid responses fall back to rules.
- Browser tests: live-day controls, approval flow, replay chart renders, settings re-run.

## 7. Assumptions to state on stage

- Carriers A–C can take a set amount of extra daily volume (setting; the data does not record capacity).
- A second pick wave at 11:30 is operationally possible within warehouse pick capacity (setting).
- Stock transfers take one day.
- Outcome rates for decided orders equal the rates the same carrier, distance and order condition achieved in history.

## 8. Out of scope for the 2–3 day build

- A real mailbox feeding the Intake agent (the gateway endpoint exists; mailbox wiring later).
- Live carrier tracking feeds; nightly model retraining.
- Weather or carrier-outage scenarios.

## 9. Open items to confirm at build start

- Foundry resource name, Claude deployment name and key (set as environment variables locally and in Azure).
- Whether the Azure database gets the decision log table through the existing `db/schema.sql` load or a migration.
