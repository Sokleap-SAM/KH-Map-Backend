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
 * Minimum stop-order gap for same-route walk shortcuts (U-shaped routes).
 * If two stops share a route but are more than this many positions apart,
 * a walk edge is still created so the router can shortcut looping segments.
 */
export const SAME_ROUTE_SHORTCUT_GAP = 5;

/**
 * TTL (seconds) for the simulation distributed-lock key in Redis.
 * Must be longer than SYNC_EVERY_N_TICKS * TICK_MS so the lock never
 * expires mid-operation on a healthy instance.
 */
export const SIM_LOCK_TTL_SECONDS = 30;
