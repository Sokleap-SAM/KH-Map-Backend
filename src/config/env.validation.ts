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
  MAP_API_KEY: Joi.string().required(),
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
  // Firebase project ID — used to verify Firebase ID tokens for one-click
  // sign-in (POST /users/firebase-login). Only the project ID is required;
  // token verification fetches Google's public keys automatically.
  FIREBASE_PROJECT_ID: Joi.string().optional().allow(''),
});
