import { registerAs } from '@nestjs/config';

export interface MqttConfig {
  /** Broker URL, e.g. `mqtt://mqtt:1883` (TCP) or `mqtts://host:8883` (TLS). */
  url: string;
  username?: string;
  password?: string;
  /** Client ID used to identify this API instance to the broker. */
  clientId: string;
}

export const mqttConfig = registerAs(
  'mqtt',
  (): MqttConfig => ({
    url: process.env.MQTT_URL!,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId:
      process.env.MQTT_CLIENT_ID ||
      `kh-map-api-${Math.random().toString(36).slice(2, 8)}`,
  }),
);
