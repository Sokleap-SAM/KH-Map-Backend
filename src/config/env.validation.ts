import * as Joi from 'joi';

/**
 * Required, and non-empty, only when NODE_ENV=production.
 *
 * Dev and CI run against docker-compose, where the in-code defaults are
 * genuinely correct — `bus_valhalla` IS the container name, and the dev broker
 * allows anonymous connections. Every one of those defaults is wrong on ECS,
 * so production has to state things explicitly or fail at boot.
 *
 * Joi schemas are immutable, so sharing one instance across keys is safe.
 */
const prodRequired = Joi.string().when('NODE_ENV', {
  is: 'production',
  then: Joi.string().required(),
  otherwise: Joi.string().allow('').optional(),
});

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  CONTAINER_PORT: Joi.number().port().default(3000),
  MONGODB_URI: Joi.string().uri().required(),
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().required(),
  // Whether to connect to Redis over TLS. Explicit because the hostname tells
  // you nothing reliable — see redis.config.ts.
  REDIS_TLS: Joi.boolean().default(false),
  CLOUDINARY_CLOUD_NAME: Joi.string().required(),
  CLOUDINARY_API_KEY: Joi.string().required(),
  CLOUDINARY_API_SECRET: Joi.string().required(),
  // ─── Auth ─────────────────────────────────────────────────────────────────
  // No fallback exists in code any more (user.module.ts / jwt.strategy.ts), so
  // a missing value fails here rather than signing tokens with a known key.
  // The dev minimum is lower only so existing local .env files keep working.
  JWT_SECRET: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(8).required(),
  }),
  // ─── Mail ─────────────────────────────────────────────────────────────────
  // Registration OTP and password reset both go through these. Sending is
  // wrapped in try/catch, so without validation a bad credential shows up as
  // users never receiving a code rather than as an error.
  EMAIL_USER: prodRequired,
  EMAIL_PASS: prodRequired,
  // ─── Routing engines ──────────────────────────────────────────────────────
  // Defaults to the `bus_valhalla` compose container name in code. Required in
  // production because that name does not resolve outside compose.
  VALHALLA_HOST: prodRequired,
  VALHALLA_PORT: Joi.number().port().default(8002),
  // ─── HTTP ─────────────────────────────────────────────────────────────────
  // Comma-separated allowlist, or a single `*` for any origin. Required in
  // production not to force an allowlist, but to force a decision: `*` is
  // accepted, a blank value is not.
  CORS_ORIGINS: prodRequired,
  // MQTT broker for live bus-position pub/sub. URL is required; auth is
  // optional (Mosquitto in dev allows anonymous, prod should set both).
  MQTT_URL: Joi.string()
    .uri({ scheme: ['mqtt', 'mqtts', 'ws', 'wss', 'tcp'] })
    .required(),
  MQTT_USERNAME: Joi.string().optional().allow(''),
  MQTT_PASSWORD: Joi.string().optional().allow(''),
  MQTT_CLIENT_ID: Joi.string().optional().allow(''),
  // ─── External broker tuning ───────────────────────────────────────────────
  // Only relevant when MQTT_URL points off-box. Defaults reproduce the
  // previous behaviour exactly, so a local Mosquitto setup needs none of them.
  MQTT_KEEPALIVE: Joi.number().min(5).max(3600).default(60),
  // Accepts "true"/"false". Never set false against a hosted broker — prefer
  // MQTT_CA_PATH for a private CA.
  MQTT_TLS_REJECT_UNAUTHORIZED: Joi.boolean().default(true),
  MQTT_CA_PATH: Joi.string().optional().allow(''),
  // ─── Broker address handed to driver apps ─────────────────────────────────
  // Returned by GET /drivers/me/mqtt-credentials so the app knows where and
  // how to connect. Must be the broker's PUBLIC address, which is not the
  // same as MQTT_URL when the API reaches it over a private network. Required
  // in production because the code falls back to `localhost`, which would
  // hand every driver an address pointing at their own phone.
  MQTT_BROKER_PUBLIC_HOST: prodRequired,
  MQTT_BROKER_PUBLIC_PORT: Joi.number().port().optional(),
  MQTT_BROKER_PUBLIC_PROTOCOL: Joi.string()
    .valid('mqtt', 'mqtts', 'ws', 'wss')
    .default('mqtt'),
  // ─── Broker → API auth callback ───────────────────────────────────────────
  // Shared secret the broker presents on every auth request, plus the backend's
  // own service account. The auth controller fails closed when the secret is
  // unset, so a dev broker running anonymous needs none of them — but in
  // production an unset secret means every driver connection is refused.
  MQTT_AUTH_INTERNAL_SECRET: prodRequired,
  MQTT_BACKEND_USERNAME: prodRequired,
  MQTT_BACKEND_PASSWORD: prodRequired,
  // Firebase project ID — used to verify Firebase ID tokens for one-click
  // sign-in (POST /users/firebase-login). Only the project ID is required;
  // token verification fetches Google's public keys automatically.
  FIREBASE_PROJECT_ID: Joi.string().optional().allow(''),
});
