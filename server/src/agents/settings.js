// The levers the agents run under. Several stand in for facts the data does not record (carrier capacity,
// warehouse pick capacity, how often an address can be completed), so each is a setting that can be changed on screen.

export const DEFAULT_SETTINGS = Object.freeze({
  seed: 42,
  secondWaveAt: '13:00',            // second pick list, an hour before carriers start collecting (14:00-18:00)
  wave2CapacityPerWarehouse: 30,    // orders each warehouse can add to the second wave per day
  carrierHeadroom: 0.25,            // carriers A-F can take their busiest historical day plus this share
  fridayPrebookShare: 0.3,          // extra A-C capacity booked from Thursday for Friday
  addressFixRate: 0.8,              // share of incomplete addresses completed before the pick list
  intakeConfidenceMin: 0.8,
  stockMissThreshold: 0.1,          // client x region miss rate that triggers safety stock at the nearest warehouse
  transferLimitPerNight: 40,        // client x region transfers allowed without approval
  watchtowerRiskMin: 0.4,           // P(late) above which an order in transit is upgraded
  costCapUsd: 6,                    // extra carrier cost per order allowed without approval
  agents: Object.freeze({ intake: true, wave: true, carrier: true, stock: true, watchtower: true }),
});

const NUMBERS = {
  seed: [0, 2 ** 31],
  wave2CapacityPerWarehouse: [0, 10000],
  carrierHeadroom: [0, 5],
  fridayPrebookShare: [0, 5],
  addressFixRate: [0, 1],
  intakeConfidenceMin: [0, 1],
  stockMissThreshold: [0, 1],
  transferLimitPerNight: [0, 10000],
  watchtowerRiskMin: [0, 1],
  costCapUsd: [0, 1000],
};

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Merges `input` over the defaults; returns the first invalid field so the screen can show it beside that input. */
export function validateSettings(input = {}) {
  const settings = { ...DEFAULT_SETTINGS, agents: { ...DEFAULT_SETTINGS.agents } };
  const fail = (field, message) => ({ ok: false, field, message });

  for (const [field, [lo, hi]] of Object.entries(NUMBERS)) {
    if (input[field] === undefined) continue;
    const v = input[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return fail(field, `${field} must be a number from ${lo} to ${hi}`);
    settings[field] = v;
  }
  if (input.secondWaveAt !== undefined) {
    const v = input.secondWaveAt;
    if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v) || minutes(v) <= minutes('08:00') || minutes(v) >= minutes('14:00')) {
      return fail('secondWaveAt', 'The second wave must be a time after 08:00 and before 14:00 (HH:MM)');
    }
    settings.secondWaveAt = v;
  }
  for (const name of Object.keys(DEFAULT_SETTINGS.agents)) {
    if (input.agents?.[name] !== undefined) settings.agents[name] = Boolean(input.agents[name]);
  }
  return { ok: true, settings };
}

export const minutesOf = minutes;
