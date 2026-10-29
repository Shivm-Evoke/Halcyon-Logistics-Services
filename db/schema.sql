SET client_min_messages = warning;
-- Halcyon Logistics — operational schema
-- Reference data and six months of history come from the hackathon dataset;
-- the tables under "Solution layer" hold the records the new app creates.

DROP VIEW IF EXISTS v_deliveries CASCADE;
DROP TABLE IF EXISTS shipment_events, users, agent_datasets, agent_decisions, api_idempotency, inbound_orders, inbound_messages, api_clients, ml_models, stock_transfers, notifications, intake_orders, complaints, sla_penalties, deliveries,
  cs_time_study, warehouse_region_distance, warehouses, carriers, clients CASCADE;

CREATE TABLE clients (
  client_id            text PRIMARY KEY,
  client_name          text NOT NULL,
  region               text NOT NULL,
  primary_order_channel text NOT NULL,
  account_tier         text NOT NULL,
  sla_penalty_clause   char(1) NOT NULL,
  annual_revenue_usd   integer NOT NULL,
  account_status       text NOT NULL
);

CREATE TABLE carriers (
  carrier_id           text PRIMARY KEY,
  carrier_name         text NOT NULL,
  has_api              char(1) NOT NULL,
  delivery_event_feed  text NOT NULL,
  preferred_supplier_agreement char(1) NOT NULL,
  base_rate_usd        numeric(8,2) NOT NULL
);

CREATE TABLE warehouses (
  warehouse_id         text PRIMARY KEY,
  warehouse_name       text NOT NULL,
  region               text NOT NULL,
  pick_list_cutoff     time NOT NULL,
  carrier_collection_window text NOT NULL
);

CREATE TABLE warehouse_region_distance (
  warehouse_id text REFERENCES warehouses,
  midwest   integer, southeast integer, northeast integer, west integer
);

CREATE TABLE deliveries (
  delivery_id          text PRIMARY KEY,
  order_id             text NOT NULL,
  client_id            text NOT NULL REFERENCES clients,
  order_channel        text NOT NULL,
  email_format_id      integer,
  order_received_ts    timestamp NOT NULL,
  commitment_type      text NOT NULL,
  promised_date        date NOT NULL,
  address_status       text NOT NULL,
  pick_list_date       date NOT NULL,
  shipped_ts           timestamp NOT NULL,
  destination_region   text NOT NULL,
  nearest_warehouse_id text NOT NULL REFERENCES warehouses,
  fulfilment_warehouse_id text NOT NULL REFERENCES warehouses,
  nearest_warehouse_had_stock char(1) NOT NULL,
  distance_miles       integer NOT NULL,
  carrier_id           text NOT NULL REFERENCES carriers,
  carrier_rate_usd     numeric(8,2) NOT NULL,
  stops_on_route       integer NOT NULL,
  planned_route_km     numeric(8,1) NOT NULL,
  actual_route_km      numeric(8,1),
  delivered_date       date NOT NULL,
  days_late            integer NOT NULL,
  on_time              char(1) NOT NULL,
  redelivery_cost_usd  numeric(8,2) NOT NULL
);
CREATE INDEX ON deliveries (client_id);
CREATE INDEX ON deliveries (order_received_ts);
CREATE INDEX ON deliveries (carrier_id);

CREATE TABLE sla_penalties (
  penalty_id  text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES deliveries,
  client_id   text NOT NULL REFERENCES clients,
  days_late   integer NOT NULL,
  penalty_usd numeric(10,2) NOT NULL
);

CREATE TABLE complaints (
  complaint_id   text PRIMARY KEY,
  complaint_date date NOT NULL,
  client_id      text NOT NULL REFERENCES clients,
  delivery_id    text NOT NULL REFERENCES deliveries,
  channel        text NOT NULL,
  category       text NOT NULL,
  escalated_to_account_owner char(1) NOT NULL,
  text           text NOT NULL
);

CREATE TABLE cs_time_study (
  staff_id   text NOT NULL,
  week_of    date NOT NULL,
  hours_total numeric(5,1),
  hours_on_delivery_complaints numeric(5,1),
  hours_keying_email_orders numeric(5,1),
  hours_on_proactive_client_work numeric(5,1)
);

-- Every delivery tagged with the failure modes found in the analysis.
-- root_cause takes the first match in priority order, so each late delivery counts once.
CREATE VIEW v_deliveries AS
SELECT d.*,
  d.on_time = 'N'                                                   AS is_late,
  extract(hour FROM d.order_received_ts)::int                       AS received_hour,
  d.address_status = 'incomplete'                                   AS f_address,
  d.commitment_type = 'same_day'
    AND d.order_received_ts::time >= w.pick_list_cutoff              AS f_cutoff,
  d.nearest_warehouse_id <> d.fulfilment_warehouse_id               AS f_stock,
  c.has_api = 'N'                                                   AS f_carrier,
  CASE
    WHEN d.on_time = 'Y' THEN NULL
    WHEN d.address_status = 'incomplete' THEN 'address'
    WHEN d.commitment_type = 'same_day' AND d.order_received_ts::time >= w.pick_list_cutoff THEN 'cutoff'
    WHEN d.nearest_warehouse_id <> d.fulfilment_warehouse_id THEN 'stock'
    WHEN c.has_api = 'N' THEN 'carrier'
    ELSE 'residual'
  END                                                               AS root_cause
FROM deliveries d
JOIN carriers c   ON c.carrier_id = d.carrier_id
JOIN warehouses w ON w.warehouse_id = d.fulfilment_warehouse_id;

-- ---------- Solution layer ----------

CREATE TABLE notifications (
  id           serial PRIMARY KEY,
  delivery_id  text REFERENCES deliveries,
  client_id    text NOT NULL REFERENCES clients,
  channel      text NOT NULL,
  message      text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamp NOT NULL DEFAULT now()
);

CREATE TABLE stock_transfers (
  id            serial PRIMARY KEY,
  client_id     text NOT NULL REFERENCES clients,
  warehouse_id  text NOT NULL REFERENCES warehouses,
  units         integer NOT NULL CHECK (units > 0),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'planned',   -- planned | in_transit | received
  created_at    timestamp NOT NULL DEFAULT now()
);

-- Trained models (risk model weights, metrics and backtest), newest row is live.
CREATE TABLE ml_models (
  id          serial PRIMARY KEY,
  kind        text NOT NULL,
  version     text NOT NULL,
  trained_at  timestamp NOT NULL DEFAULT now(),
  metrics     jsonb NOT NULL,
  params      jsonb NOT NULL
);

-- ---------- Inbound gateway ----------

-- Client API credentials (secrets stored as scrypt hashes only).
CREATE TABLE api_clients (
  client_id      text PRIMARY KEY REFERENCES clients,
  secret_hash    text NOT NULL,
  created_at     timestamp NOT NULL DEFAULT now(),
  last_login_at  timestamp
);

-- One row per inbound message: an API call, an email or an EDI file.
CREATE TABLE inbound_messages (
  id          serial PRIMARY KEY,
  channel     text NOT NULL,                 -- API | Email | EDI
  source      text,                          -- sender address, API client or file name
  subject     text,
  received_at timestamp NOT NULL DEFAULT now(),
  raw         text,
  status      text NOT NULL DEFAULT 'processing',
  summary     jsonb,
  reply       text                           -- email reply / EDI 997 sent back to the client
);

-- One row per order found in a message, with everything the pipeline decided about it.
CREATE TABLE inbound_orders (
  id               serial PRIMARY KEY,
  message_id       integer NOT NULL REFERENCES inbound_messages ON DELETE CASCADE,
  source_ref       text,
  client_id        text,
  client_order_ref text,
  status           text NOT NULL,            -- accepted | corrected | held | rejected | duplicate
  normalized       jsonb NOT NULL,
  corrections      jsonb NOT NULL DEFAULT '[]',
  issues           jsonb NOT NULL DEFAULT '[]',
  risk             numeric,
  drivers          jsonb,
  commitment_type  text,
  promised_date    date,
  warehouse_id     text,
  carrier_id       text,
  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now()
);
CREATE INDEX ON inbound_orders (client_id, client_order_ref);
CREATE INDEX ON inbound_orders (message_id);

-- Replayed API requests return the first response instead of creating duplicates.
CREATE TABLE api_idempotency (
  client_id  text NOT NULL,
  key        text NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, key)
);

-- Every decision the operations agents take, with its rule, Claude's reason and its approval state.
CREATE TABLE agent_decisions (
  id            serial PRIMARY KEY,
  run_id        text NOT NULL,
  sim_ts        text NOT NULL,
  agent         text NOT NULL,
  delivery_id   text,
  decision      jsonb NOT NULL DEFAULT '{}',
  rule          text,
  reason        text,
  reason_source text NOT NULL DEFAULT 'rules only' CHECK (reason_source IN ('claude', 'rules only')),
  approval      text NOT NULL CHECK (approval IN ('auto', 'pending', 'approved', 'rejected', 'expired')),
  actor         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_decisions_run ON agent_decisions (run_id, approval);

-- Test datasets uploaded for the agents to run on; kept apart from the history.
CREATE TABLE agent_datasets (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rows         integer NOT NULL,
  days         jsonb NOT NULL,
  has_outcomes boolean NOT NULL,
  rejected     jsonb NOT NULL DEFAULT '[]',
  orders       jsonb NOT NULL
);

-- Website accounts: customers (one client each) and Halcyon staff, created with the account tool (npm --prefix server run users).
CREATE TABLE users (
  id             serial PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('customer', 'staff')),
  client_id      text REFERENCES clients,
  name           text,
  created_at     timestamp NOT NULL DEFAULT now(),
  last_login_at  timestamp,
  active         boolean NOT NULL DEFAULT true,
  session_version integer NOT NULL DEFAULT 0,  -- raised on sign-out, password reset or disable: ends existing sessions
  CHECK (role = 'staff' OR client_id IS NOT NULL)
);

-- Shipment stages of gateway orders: the gateway's verdict, then each step staff take on the Dispatch board.
CREATE TABLE shipment_events (
  id        serial PRIMARY KEY,
  order_id  integer NOT NULL REFERENCES inbound_orders ON DELETE CASCADE,
  stage     text NOT NULL,                  -- received | picked | collected | in_transit | delivered | on_hold | cancelled
  at        timestamp NOT NULL DEFAULT now(),
  by        text NOT NULL DEFAULT 'system',
  note      text
);
CREATE INDEX ON shipment_events (order_id);
