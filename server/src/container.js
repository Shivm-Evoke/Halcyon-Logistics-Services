// Composition root: builds the ML and data-quality services once and shares them with the routes.
// Routes depend on these objects' interfaces, never on how they are constructed.
import { q } from './db.js';
import { carrierStats } from './stats.js';
import { mlRepository } from './ml/repository.js';
import { ModelRegistry, TEST_FROM } from './ml/ModelRegistry.js';
import { NextBestAction } from './ml/NextBestAction.js';
import { CapacitySimulator } from './ml/CapacitySimulator.js';
import { AnomalyService } from './quality/AnomalyService.js';
import { DataQualityScanner } from './quality/DataQualityScanner.js';
import { ingestRepository } from './ingest/repository.js';
import { IngestPipeline } from './ingest/pipeline.js';
import { IngestService } from './ingest/IngestService.js';
import { createClaude } from './agents/claude.js';
import { DEFAULT_SETTINGS } from './agents/settings.js';
import { deskClock } from './desk/instance.js';

async function build() {
  const started = performance.now();
  const carriers = await carrierStats();
  const [registry, rows, distances] = await Promise.all([
    new ModelRegistry(mlRepository, { carriers }).init(),
    mlRepository.loadDeliveries(),
    mlRepository.loadDistances(),
  ]);
  // Historical share of a client's orders to a region that found no stock at the nearest warehouse.
  const miss = new Map();
  for (const r of rows) {
    const k = `${r.client_id}|${r.destination_region}`;
    const m = miss.get(k) || { n: 0, miss: 0 };
    m.n++; m.miss += r.stock_miss;
    miss.set(k, m);
  }
  const stockMiss = (clientId, region) => { const m = miss.get(`${clientId}|${region}`); return m ? m.miss / m.n : 0; };
  const days = new Set(rows.map((r) => String(r.order_received_ts).slice(0, 10)));
  const container = {
    carriers,
    stockMiss,
    distances,
    registry,
    avgDailyOrders: Math.round(rows.length / days.size),
    capacitySimulator: new CapacitySimulator({
      // Looks the model up on every call, so a retrain takes effect immediately.
      rows: rows.map(registry.prepare), riskFn: (r) => registry.models.evaluation.risk(registry.prepare(r)),
      carriers, distances, splitAt: TEST_FROM,
    }),
    anomalies: new AnomalyService(rows, { profileUntil: TEST_FROM }),
    scanner: new DataQualityScanner(q),
    nextBestAction: (which = 'production') => new NextBestAction(registry.scorer(which), { carriers }),
  };
  const anomalies = container.anomalies;
  container.ingestRepo = ingestRepository;
  container.claude = createClaude();
  container.ingest = new IngestService(new IngestPipeline({
    repo: ingestRepository,
    deferCutoff: process.env.DESK !== '0',
    clients: await ingestRepository.loadClients(),
    ai: {
      get scorer() { return registry.scorer(); },
      anomalies,
      get capacity() { return registry.capacity; },
      nextBestAction: { decide: (o, opts) => container.nextBestAction().decide(o, opts) },
      avgDailyOrders: container.avgDailyOrders,
      distances,
      stockMiss,
    },
  }), container.claude.available
    ? { extractEmail: (text) => container.claude.extractEmail(text), minConfidence: DEFAULT_SETTINGS.intakeConfidenceMin }
    : null, { clock: deskClock }); // orders without a time of their own are received at the desk's ops clock
  console.log(`ML ready in ${Math.round(performance.now() - started)} ms (model ${registry.meta.version})`);
  return container;
}

let instance;
export const getContainer = () => (instance ??= build());
