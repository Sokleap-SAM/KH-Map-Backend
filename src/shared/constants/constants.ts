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

/**
 * Dwell time (minutes) the bus is stationary at each intermediate stop while
 * passengers board and alight. Added to per-segment cost in routing so ETAs
 * stop systematically under-promising on long rides, and enforced in the
 * simulator so the on-map bus matches what the routing engine predicts.
 */
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
 * Haversine distance (meters) within which the simulated bus is considered
 * to have arrived at its next stop. The simulator advances along the
 * segmentPath waypoints, but the last waypoint isn't always exactly at the
 * stop's stored coordinates — without this threshold the bus can sit ~10 m
 * short of the stop and never load the next segment. ±5 m snaps it cleanly.
 */
export const STOP_ARRIVAL_RADIUS_M = 5;

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

/**
 * TTL (seconds) for the per-route "last departure from first stop" anchor in
 * Redis. The routing service uses this anchor to project the next lap's
 * arrival at any boarding stop as `anchor + headway + ridePrefix`, which is
 * stable across requests (doesn't slide with wall-clock the way a pure
 * "now + headway" projection does). Set generously so the anchor survives a
 * quiet period or a restart; the simulator overwrites it on every lap.
 */
export const ROUTE_DEPARTURE_ANCHOR_TTL_SECONDS = 24 * 60 * 60;

// ─── Runtime / Routing config ───────────────────────────────────────────────

/** In-memory network cache TTL in milliseconds (used by TransitRoutingService) */
export const NETWORK_CACHE_TTL_MS = 5 * 60 * 1000;

/** Redis key for the persisted, pre-computed transit network snapshot. */
export const NETWORK_CACHE_REDIS_KEY = 'transit:network:v1';

/**
 * TTL (seconds) for the Redis-backed network cache. Long because we invalidate
 * explicitly on route/stop CRUD; the TTL is just a safety net so stale data
 * eventually disappears if invalidation is missed (e.g. direct DB edit).
 */
export const NETWORK_CACHE_REDIS_TTL_SECONDS = 24 * 60 * 60;

/**
 * How many footpath sources to batch into a single Valhalla matrix call when
 * building the network cache. Picked so each request stays under the
 * ValhallaService timeout while keeping total HTTP overhead small.
 */
export const VALHALLA_FOOTPATH_SOURCE_BATCH = 50;

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

/** Search radii steps (meters) used for origin expansion attempts */
export const ORIGIN_RADII_M = [1000, 2000, 3000, Infinity];

/** Default RAPTOR max rounds */
export const RAPTOR_MAX_ROUNDS = 4;

/** Transfer penalty (minutes) used for ranking options (larger than TRANSFER_PENALTY_MIN) */
export const TRANSFER_PENALTY_FOR_RANKING = 15;

/**
 * Slack (minutes) for the round-1 footpath improvement check. RAPTOR's strict
 * `arrival < tauStar` comparison rejects transfers that are slightly worse than
 * direct origin walks, so chains like "ride 2A → walk to 1A stop → ride 1A"
 * never get explored when the user is far from the network and direct walks
 * dominate every stop. Allowing footpaths within this slack to set a label
 * (and update tauStar) surfaces these chains without exploding label count.
 */
export const FOOTPATH_RELAXATION_MIN = 5;

/**
 * How long (ms) a previously-returned transit option stays "sticky" — re-merged
 * into subsequent plan responses even when it falls out of the candidate set.
 * Bus simulation advances every tick, which shifts boarding ETAs and can flip
 * borderline options across qualification thresholds. Without hysteresis the
 * user sees an option appear, disappear, reappear within seconds. 60 s is long
 * enough to absorb headway-rollover jitter and short enough that stale options
 * don't linger.
 */
export const OPTION_HYSTERESIS_MS = 60_000;

/** Threshold for flagging a long initial walk (meters) */
export const LONG_WALK_WARNING_M = 1500;

/** Number of top transit options to return for UI */
export const TOP_TRANSIT_OPTIONS = 5;
