// ─── Transit Routing ─────────────────────────────────────────────────────────

/** Walking speed used for time estimates (km/h) */
export const WALK_SPEED_KMH = 5;

/** Bus speed used for routing cost estimation (km/h) */
export const BUS_ROUTING_SPEED_KMH = 25;

/** Base transfer walk radius (meters) used in early RAPTOR rounds. */
export const TRANSFER_WALK_BASE_RADIUS_M = 1000;

/** Additional transfer walk radius added per RAPTOR round (meters). */
export const TRANSFER_WALK_RADIUS_GROWTH_PER_ROUND_M = 500;

/** Hard cap for transfer walk radius (meters) in later RAPTOR rounds. */
export const TRANSFER_WALK_MAX_RADIUS_M = 3000;

/** Backward-compatible alias for existing callers expecting a single transfer radius. */
export const TRANSFER_WALK_RADIUS_M = TRANSFER_WALK_BASE_RADIUS_M;

export const RIVER_THRESHOLD_MIN = 5; // b1 > this triggers expansion

export const RIVER_EXPAND_BASE_RADIUS_M = 800; // starting search radius

export const RIVER_EXPAND_MAX_RADIUS_M = 3000; // cap on expansion

export const RIVER_EXPAND_CANDIDATE_CAP = 6;

/**
 * Max walking distance (meters) for the final walk from alight stop to destination.
 * Candidate alight stops beyond this distance are skipped unless no closer stop exists.
 * Mirrors MAX_ORIGIN_WALK_M logic: cap only applies when a closer stop is available.
 */
export const MAX_DEST_WALK_M = 1000;

/**
 * Max walking distance (meters) to seed a stop from origin in RAPTOR round 0.
 * Stops beyond this distance are NOT pre-seeded; they must be discovered
 * through transfers from nearby routes. This is critical for multi-transfer
 * journeys: if all routes are force-seeded in round 0, RAPTOR can never
 * produce a 2-leg transfer option because everything is found in round 1.
 */
export const MAX_ORIGIN_WALK_M = 1000;

/** Time penalty (minutes) added when transferring between routes */
export const TRANSFER_PENALTY_MIN = 2;

/**
 * Catchability buffer (minutes): a bus is only catchable if it arrives at least
 * this many minutes AFTER the user reaches the stop. Spec: 2-minute buffer.
 */
export const MIN_WAIT_MIN = 1;

/**
 * Extra catchability buffer applied ONLY at transfer boardings (round > 1).
 * The user's arrival at a transfer stop has compounded uncertainty (ride time
 * variation + walk pace + dwell), so we refuse to commit to a live ETA that is
 * only marginally catchable. Live ETAs more than this many minutes past
 * `arrival + MIN_WAIT_MIN` are still accepted; closer ones are treated as missed
 * and we project the next lap. Does NOT apply to the first boarding from origin,
 * where the user controls their start time precisely.
 */
export const TRANSFER_UNCERTAINTY_BUFFER_MIN = 5;

/** Dwell time (minutes) added per stop for boarding/alighting delay (25 s) */
export const DWELL_TIME_MIN = 25 / 60;

// ─── Bus Simulation ───────────────────────────────────────────────────────────

/** Wall-clock interval between simulation position updates (ms) */
export const TICK_MS = 1_000;

/** Simulated bus speed (km/h) — urban average (~8.3 m/s) */
export const BUS_SIMULATION_SPEED_KMH = 30;

/** Metres the bus moves each simulation tick */
export const SIMULATION_SPEED_M_PER_TICK =
  (BUS_SIMULATION_SPEED_KMH * 1_000) / 3_600;

/** Re-sync active-trip list from MongoDB every N ticks */
export const SYNC_EVERY_N_TICKS = 5;

/**
 * TTL (seconds) for the simulation distributed-lock key in Redis.
 * Must be longer than SYNC_EVERY_N_TICKS * TICK_MS so the lock never
 * expires mid-operation on a healthy instance.
 */
export const SIM_LOCK_TTL_SECONDS = 30;

/**
 * Minimum interval between persisted bus_location documents per trip.
 * Redis still updates every tick (cheap, used by live-ETA queries); the
 * MongoDB write — which historically inserted a new document every second
 * per active bus and bloated the cluster — is throttled to once per this
 * interval, and uses upsert-by-trip so each trip occupies exactly one doc.
 */
export const BUS_LOCATION_DB_WRITE_INTERVAL_MS = 300_000; // 5 minutes

/**
 * TTL (seconds) for bus_location documents in MongoDB. Combined with the
 * upsert pattern, active trips keep their `recordedAt` fresh and never
 * expire; trips that go quiet (crashed simulator, paused service) age out.
 */
export const BUS_LOCATION_TTL_SECONDS = 6 * 60 * 60;
// ─── Runtime / Routing config ───────────────────────────────────────────────

/** Network cache TTL in milliseconds (used by TransitRoutingService) */
export const NETWORK_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Live ETA cache TTL in milliseconds. Multiple plan requests within this window
 * reuse the same snapshot of bus positions, so plans don't jitter second-by-second
 * as the simulation ticks. Short enough that live data stays fresh.
 */
export const LIVE_ETA_CACHE_TTL_MS = 15 * 1000;

/**
 * When two alight candidates have totals within this many minutes of each other,
 * prefer the one with fewer total bus-ride minutes. This biases toward
 * geographically direct transfers when timing is approximately equal.
 */
export const TIE_DELTA_MIN = 2;

/** Search radii steps (meters) used for origin/destination expansion attempts */
export const ORIGIN_RADII_M = [1000, 2000, 3000, Infinity];
export const DEST_RADII_M = [1000, 2000, 3000, Infinity];

/** Default RAPTOR max rounds */
export const RAPTOR_MAX_ROUNDS = 4;

/** Transfer penalty (minutes) used for ranking options (larger than TRANSFER_PENALTY_MIN) */
export const TRANSFER_PENALTY_FOR_RANKING = 15;

/** Threshold for flagging a long initial walk (meters) */
export const LONG_WALK_WARNING_M = 1500;

/** Number of top transit options to return for UI */
export const TOP_TRANSIT_OPTIONS = 5;
