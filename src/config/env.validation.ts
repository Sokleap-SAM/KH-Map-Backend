import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  CONTAINER_PORT: Joi.number().port().default(3000),
  MONGODB_URI: Joi.string().uri().required(),
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().required(),
  CLOUDINARY_CLOUD_NAME: Joi.string().required(),
  CLOUDINARY_API_KEY: Joi.string().required(),
  CLOUDINARY_API_SECRET: Joi.string().required(),
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
  // same as MQTT_URL when the API reaches it over a private network.
  MQTT_BROKER_PUBLIC_HOST: Joi.string().optional().allow(''),
  MQTT_BROKER_PUBLIC_PORT: Joi.number().port().optional(),
  MQTT_BROKER_PUBLIC_PROTOCOL: Joi.string()
    .valid('mqtt', 'mqtts', 'ws', 'wss')
    .default('mqtt'),
  // ─── Broker → API auth callback ───────────────────────────────────────────
  // Shared secret the broker presents on every auth request, plus the backend's
  // own service account. The auth controller fails closed when the secret is
  // unset, so these stay optional for a dev broker running anonymous.
  MQTT_AUTH_INTERNAL_SECRET: Joi.string().optional().allow(''),
  MQTT_BACKEND_USERNAME: Joi.string().optional().allow(''),
  MQTT_BACKEND_PASSWORD: Joi.string().optional().allow(''),
  // Firebase project ID — used to verify Firebase ID tokens for one-click
  // sign-in (POST /users/firebase-login). Only the project ID is required;
  // token verification fetches Google's public keys automatically.
  FIREBASE_PROJECT_ID: Joi.string().optional().allow(''),
});
