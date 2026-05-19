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
// ─── Runtime / Routing config ───────────────────────────────────────────────

/** Network cache TTL in milliseconds (used by TransitRoutingService) */
export const NETWORK_CACHE_TTL_MS = 5 * 60 * 1000;

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
