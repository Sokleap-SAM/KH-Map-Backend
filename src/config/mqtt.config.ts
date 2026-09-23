import { registerAs } from '@nestjs/config';
import { readFileSync } from 'fs';

export interface MqttConfig {
  /** Broker URL, e.g. `mqtt://mqtt:1883` (TCP) or `mqtts://host:8883` (TLS). */
  url: string;
  username?: string;
  password?: string;
  /** Client ID used to identify this API instance to the broker. */
  clientId: string;
  /**
   * Seconds between PINGREQs. The mqtt.js default (60) is fine for a broker on
   * the same Docker network, but hosted brokers and the NAT gateways in front
   * of them commonly cut idle TCP connections sooner — the socket then looks
   * alive to us while publishes silently vanish. Lower this if an external
   * broker drops the backend between bus ticks.
   */
  keepalive: number;
  /**
   * Whether to reject a broker whose TLS certificate doesn't validate. Managed
   * brokers use publicly-trusted CAs and need nothing here. Set false ONLY for
   * a self-signed cert in development — it disables the check that stops an
   * attacker from impersonating the broker.
   */
  rejectUnauthorized: boolean;
  /**
   * PEM CA bundle, loaded from `MQTT_CA_PATH`, for a broker behind a private
   * CA (a self-hosted remote Mosquitto/EMQX with an internal certificate).
   * Preferred over disabling `rejectUnauthorized`.
   */
  ca?: string;
}

/** Read the CA bundle once at config time; a bad path should fail loudly at boot. */
function loadCa(): string | undefined {
  const path = process.env.MQTT_CA_PATH;
  if (!path) return undefined;
  return readFileSync(path, 'utf8');
}

export const mqttConfig = registerAs('mqtt', (): MqttConfig => ({
  url: process.env.MQTT_URL!,
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  clientId:
    process.env.MQTT_CLIENT_ID ||
    `kh-map-api-${Math.random().toString(36).slice(2, 8)}`,
  keepalive: Number(process.env.MQTT_KEEPALIVE ?? 60),
  // Default true — only an explicit "false" opts out.
  rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
  ca: loadCa(),
}));
