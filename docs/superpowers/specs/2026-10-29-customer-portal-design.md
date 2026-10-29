# Halcyon as a logistics company: public site, logins, customer portal

Date: 2026-10-29 · Deadline: demo-ready tomorrow · Branch: `feature/customer-portal`

## Goal

Turn the live hackathon app into something that looks and works like a logistics company, with one
end-to-end path a judge can click through:

1. A **customer** signs in, places an order and sees it in *My shipments*.
2. The order goes through the existing **middleware** (the inbound gateway pipeline: validation, fixes,
   holds, AI risk, promised date, carrier).
3. **Halcyon staff** sign in, see the order (gateway, control tower) and move it along on a new
   **Dispatch board**.
4. The customer sees the status, carrier and promised date change; a held order shows what to fix and
   the customer can fix it.

Out of scope for tomorrow: carrier portal, billing/invoices, webhooks, self sign-up, password reset,
email notifications, multiple users per client.

## What exists and is reused

- `server/src/ingest/auth.js`: scrypt `hashSecret`/`checkSecret`, HS256 `signToken`/`verifyToken`;
  `JWT_SECRET` is already set in Azure.
- Client API `/api/v1/orders` (POST, GET list, GET one, PATCH fix) and `IngestService.api(clientId,
  orders)`: the same pipeline the portal will call. `inbound_orders` already stores status, issues,
  corrections, risk, promised_date, warehouse_id, carrier_id per order.
- `deliveries` history (per client) for the customer dashboard numbers.
- All existing screens become the staff area, unchanged in content.

## Users and sessions

- New table `users`: `id`, `email` (unique, lower-case), `password_hash` (scrypt), `role`
  (`customer` | `staff`), `client_id` (required for customers, references `clients`), `name`,
  `created_at`, `last_login_at`. Created at startup if missing (same pattern as `ensureDecisionTable`)
  and added to `db/schema.sql` and its DROP list.
- Demo accounts are seeded at startup from environment variables, never from code:
  `DEMO_CUSTOMER_EMAIL`/`DEMO_CUSTOMER_PASSWORD`/`DEMO_CUSTOMER_CLIENT` (default client `C055`) and
  `DEMO_STAFF_EMAIL`/`DEMO_STAFF_PASSWORD`. A variable left unset seeds nothing. Seeding updates the
  password hash if the account exists. Local values go in git-ignored `server/.env`; production in
  Azure App Settings.
- `POST /api/session/login {email, password}` → sets cookie `halcyon_session` (signed token with
  `sub`, `role`, `client_id`; HttpOnly, SameSite=Lax, Secure in production; 8 hours) and returns
  `{ name, role, client_id }`. Wrong email or password → 401 with one generic message.
  `POST /api/session/logout` clears it. `GET /api/session` returns the user or 401.
- Login attempts are limited to 10 per email per 15 minutes (in memory) → 429.

## Access rules

- Public (no session): `/api/health`, `/api/session/*`, the client API `/api/auth/*` and `/api/v1/*`
  (own bearer tokens, unchanged), `/api/openapi.json`, `/api/docs`, and the website files.
- Customer only: `/api/portal/*`; every query is scoped to the session's `client_id`.
- Staff only: every other `/api/*` route (the existing ones).
- Switch: `REQUIRE_LOGIN` (default on). Playwright's config sets it on and signs in as a seeded test
  staff user through a global setup, so the existing tests run as staff.
- The old `SITE_PASSWORD` gate stays as is (unset in production).

## Customer portal API (`/api/portal`)

- `GET /portal/summary`: client name and tier; last 90 days of history from `deliveries` (orders,
  on-time rate); open portal orders by status.
- `POST /portal/orders`: one order from a form (sku, quantity, service, ship-to name/street/city/
  state/zip, optional client reference) → `ingest.api(client_id, [order])` → the gateway's own order
  result (ref, status, issues, promised date, carrier).
- `GET /portal/orders`: this client's gateway orders, newest first, each with its shipment stage.
- `GET /portal/orders/:ref`: one order with its stage timeline (events) and issues.
- `PATCH /portal/orders/:ref`: fix a held order, delegating to the same `ingest.reprocess` the client
  API uses.

## Shipment stages

New table `shipment_events`: `id`, `order_id` → `inbound_orders`, `stage`, `at`, `by` (`system` |
staff email), `note`. Stages in order: `received` → `picked` → `collected` → `in_transit` →
`delivered`, plus `on_hold` for held orders and `cancelled` for rejected ones.

- The gateway result writes the first event: `received` for accepted/corrected, `on_hold` for held,
  `cancelled` for rejected/duplicate. A fixed and released hold writes `received`.
- Staff move an order one stage forward on the Dispatch board; a stage can't be skipped or reversed,
  and a held order can't be moved until it is released.
- The current stage is the latest event. "At risk" comes from the gateway's stored risk (≥ 0.4, the
  watchtower threshold) and shows on the order with its promised date.

## Staff additions

- `GET /api/dispatch` lists gateway orders not delivered/cancelled, grouped by stage, with client,
  carrier, promised date and risk. `POST /api/dispatch/:id/advance` moves one stage, recording the
  staff email.
- New screen **Dispatch board** in the staff sidebar (columns per stage, an "Advance" button per card).

## Website structure

- `/`: new public homepage for Halcyon Logistics (what we do, the on-time promise, the numbers from
  the history, *Sign in*). The current "Start here" screen moves to `/start`.
- `/login`: one sign-in form; customers go to `/portal`, staff to `/start`.
- `/portal`: customer area with its own simple layout (not the story scroll): Dashboard, New order,
  My shipments, shipment detail (`/portal/shipments/:ref`), sign out.
- Staff area: the existing story app and Dispatch board. Opening a staff page without a staff
  session sends the browser to `/login`; a customer opening it is sent to `/portal`.

## Errors and edge cases

- Expired session → API 401 → the web app sends the user to `/login` with a "session expired" note.
- A customer can never read or change another client's order: 404, not 403, for foreign refs.
- Pipeline validation errors come back as the order's issues, shown beside the form fields.
- No demo account configured → the login page says sign-in isn't set up yet.

## Testing

- Unit (node:test): password/session cookie round trip and tampering; access rules (public,
  customer, staff, wrong role); client scoping of portal queries; stage transitions (forward only,
  holds blocked); seeding from env (unset → nothing; re-seed → new hash); login rate limit.
- E2E (Playwright): customer signs in → places an order → sees it in My shipments; staff signs in →
  advances it on the Dispatch board; customer sees the new stage; a customer can't open staff
  screens. Existing tests keep passing as staff.

## Deployment

Add to Azure App Settings before merging: `DEMO_CUSTOMER_EMAIL`, `DEMO_CUSTOMER_PASSWORD`,
`DEMO_STAFF_EMAIL`, `DEMO_STAFF_PASSWORD` (the user chooses and enters the passwords). Merge to
`main` deploys as before.
