// The server's one live order desk, built on first use. The container and the agents' history are loaded with
// dynamic imports: routes/agents.js imports container.js, and container.js reads the desk's clock from here.
import { createDesk } from './service.js';
import { deskRepo } from './repository.js';
import { decisionLog } from '../agents/log.js';
import { shipmentStore } from '../shipments/store.js';
import { DEFAULT_SETTINGS } from '../agents/settings.js';

let desk = null;
let building = null;

/** The desk (DESK=0 gives one that does nothing). Loads its clock and runs once when first built. */
export function getDesk() {
  return (building ??= (async () => {
    const enabled = process.env.DESK !== '0';
    const [{ getContainer }, { world }] = await Promise.all([import('../container.js'), import('../routes/agents.js')]);
    const container = enabled ? await getContainer() : null;
    const built = createDesk({
      repo: deskRepo, log: decisionLog, shipments: shipmentStore, world, claude: container?.claude ?? null,
      settings: DEFAULT_SETTINGS, stockMiss: container?.stockMiss, enabled,
    });
    await built.refresh();
    desk = built;
    return built;
  })().catch((e) => { building = null; throw e; }));
}

/** The ops clock for the gateway's timestamps ('YYYY-MM-DD HH:MM'), or null until the desk is loaded or with it off. */
export const deskClockNow = () => desk?.clockNow() ?? null;

/**
 * The ops clock, building the desk and loading its clock first if needed (the first order after a restart is on the
 * ops clock too); null with DESK=0.
 */
export async function deskClock() {
  if (process.env.DESK === '0') return null;
  return (await getDesk()).currentClock();
}

/** Re-runs the desk after an order arrives, is fixed or an approval changes; never throws, so a response never fails on it. */
export async function refreshDesk() {
  try {
    await (await getDesk()).refresh();
  } catch (e) {
    console.error(`Desk run failed: ${e.message}`);
  }
}
