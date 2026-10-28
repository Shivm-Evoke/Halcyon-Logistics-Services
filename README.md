# Halcyon Control

A working demo for Hackathon 5.0, Problem 2. Leadership blames carrier routing for Halcyon's late deliveries, but the data shows that
94% of late deliveries are caused before the truck leaves. This app runs on the real six-month dataset (48,340 deliveries) and puts
a fix in front of each root cause.

| Screen | Issue | What it does |
|---|---|---|
| Start here | — | Presenter guide: the story in nine steps, the brief mapped to screens, process map, known vs assumed, the one outcome metric, open questions, and the data behind the app |
| Executive overview | — | On-time trend, root-cause split, cost of lateness, customer success workload |
| Late-delivery diagnosis | — | Evidence for each cause, and the two tests that rule routing out |
| Inventory placement | I3 | Stock-out matrix and safety-stock transfers per client and warehouse |
| Carrier scorecard | I4 | Expected-cost carrier choice; time-critical orders only to carriers late on <10% of clean orders |
| Exceptions control tower | I5 | Scores in-flight orders for risk of being late and sends proactive notices; checks the model against real outcomes |
| Account health | I9 | Nine at-risk accounts, with per-client failure pattern and recovery plan |
| AI risk model | ML | Late-risk model: out-of-time accuracy, calibration, drivers, capacity-limited backtest (71% → 92.7–93.9% on-time), live scorer |
| Data quality | I10 | 13 rule checks on ingested data + per-client anomaly screen on incoming orders |
| Inbound gateway | I1, I2 | API (login + token), EDI 850, email (.eml upload / drop folder / webhook) and CSV drops through one normalise → validate → AI pipeline; re-promises same-day orders after the 8am cutoff; replies to the client |
| What-if & vendor decision | I6 | Simulates each fix on the history: 71% → 95% on-time, vs 72.7% for routing alone |

## Stack

- **db/**: PostgreSQL schema, plus a `v_deliveries` view that tags every delivery with its failure flags and root cause
- **server/**: Node + Express API; the business rules live in `src/rules.js` with unit tests
- **web/**: React (Vite) + Recharts for every chart
- **e2e/**: Playwright tests that run the whole stack against a separate `halcyon_test` database

## AI layer

`server/src/ml` and `server/src/quality`, wired together in `server/src/container.js`:

- **Risk model** (`RiskModel` = `FeatureEncoder` + `LogisticRegression`): L2 logistic regression trained with Newton/IRLS on
  Apr–Aug, tested on September (AUC ≈ 0.81, calibration error < 1%). Trains in under a second at startup, is stored in
  `ml_models`, and scores an order in under 1 µs in-process. Each score comes with its drivers (per-feature impact in points).
- **Next best action** (`NextBestAction`): tries every carrier and promise for an order and picks the lowest expected cost
  (rate + P(late) × late cost), skipping carriers that are full for the day. `allocate()` plans a whole day at once,
  giving scarce capacity to the orders that lose most without it (regret heuristic). Used in Order intake and the live scorer.
- **Backtest** (`backtest.js`): replays September under each policy. Because the model is calibrated, its estimate of today
  (71.2%) matches reality (71.1%); clean data + next-best-action gives about 95% on-time.
- **Data quality** (`checks.js`, `DataQualityScanner`): one entry per rule; adding a check means adding one object.
- **Anomaly screen** (`ClientProfiler`, `AnomalyService`): learns each client's normal orders and flags breaks
  (bad address, impossible promise, duplicate order IDs, unusual destination, channel or time) in microseconds per order.

API: `GET /api/ml/model`, `GET /api/ml/backtest`, `POST /api/ml/retrain`, `POST /api/ml/score` (`{order}` or `{orders: []}`),
`POST /api/ml/decide` (optional `used` = today's carrier usage), `GET /api/ml/capacity?max_share=&headroom=`, `GET /api/quality/scan`, `GET /api/quality/checks/:id`, `GET /api/quality/anomalies`, `POST /api/quality/inspect`.

## Inbound gateway

See [ingest/README.md](ingest/README.md) for how client data arrives, the pipeline, and how to test every channel with the generated test pack
(`npm run ingest:testdata`, `npm run ingest:test`, drop files into `inbox/`, API docs at `/api/docs`).

## Synthetic data

`ingest/generate-live-week.mjs` builds a realistic week of client traffic (Mon 26 Oct – Sun 1 Nov 2026, ~2,000 orders in ~550
email, API, EDI and file-drop messages) from the supplied data: each client's volume, channel, regions, service mix and order hours.
It injects 23 kinds of data problem at realistic per-channel rates (e.g. half-written addresses in email, spreadsheet-damaged ZIPs in
file drops, resent POs, unknown senders, corrupted EDI) and records each as ground truth. `ingest/run-live-week.mjs` sends the week
through the running gateway and scores it; the result is shown on the Inbound gateway screen.

```bash
npm run demo:fresh   # reload the dataset, then generate and send one week (API must be running)
npm run demo:week    # send another week on top
node ingest/generate-live-week.mjs --seed 42 && node ingest/run-live-week.mjs   # a different random week
```

## Run it

Prerequisites: Node 20+ and PostgreSQL running locally (`brew install postgresql@18 && brew services start postgresql@18`).
The hackathon dataset ships in `db/data/`.

```bash
npm run setup      # install all dependencies + Playwright Chromium, create and load the halcyon database
npm run dev        # API on :4000 and UI on http://localhost:5173 together
npm test           # rule unit tests + end-to-end browser tests
```

`npm run test:e2e` starts its own API (:4100) and UI (:5174) on a fresh `halcyon_test` database, so it never
touches your dev data; the HTML report is written to `e2e-report/`. `npm run db:reset` restores the dev database
(clears intake orders, transfers and notices).

## Deploy

The app deploys as one Docker container (API, risk model, inbound gateway and the built website) plus PostgreSQL.
`render.yaml` sets both up on [Render](https://render.com): push the repo to GitHub, then New → Blueprint → pick the
repo → Apply, and enter a `SITE_PASSWORD` when asked. Every push to `main` redeploys.

- On first start the container loads `db/data/` into the empty database and trains the model (seconds).
- `SITE_PASSWORD` puts a browser password prompt in front of the site; `/api/health` and the client API
  (`/api/auth/login`, `/api/v1/*`, token-authenticated) stay open.
- Client API secrets are generated on first load. To keep your local ones, add your
  `ingest/test-data/credentials.json` as a Render Secret File and set `API_CREDENTIALS_FILE=/etc/secrets/credentials.json`.
- Run the checks against the live site:
  `API_URL=https://<your-app>.onrender.com/api SITE_PASSWORD=... node ingest/run-test-pack.mjs` (same for `run-live-week.mjs`).

Try the container locally first:

```bash
docker build -t halcyon-logistics .
docker run -p 8080:4000 -e DATABASE_URL=postgres://... -e SITE_PASSWORD=demo halcyon-logistics
```

## Assumptions

- The control tower treats `2026-09-22 12:00` as "now" (`DEMO_NOW`), since the data ends on 25 Sep.
- What-if: a fixed failure mode performs like clean orders on the same carrier type. Routing best case removes all residual lateness on API-tracked carriers.
- Carrier choice uses $34 redelivery plus $180 SLA penalty (SLA clients) as the cost of being late.
- Carrier capacity (`CarrierCapacity`): each carrier's daily limit is the lower of its busiest training-period day + 25% and 40% of the day's orders.
  Without it the AI would send ~100% of orders to carrier B; with it the full AI plan reaches 92.7% on-time (93.9% with 50% share and +75% capacity — try it on the AI risk model screen).
- Addresses in the dataset are only a complete/incomplete flag; the intake screen validates addresses typed or parsed in the demo.
