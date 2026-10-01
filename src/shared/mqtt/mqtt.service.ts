import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { IClientPublishOptions, MqttClient } from 'mqtt';

export const MQTT_CLIENT = Symbol('MQTT_CLIENT');

export type MqttMessageHandler = (topic: string, payload: Buffer) => void;
interface Subscription {
  pattern: string;
  handler: MqttMessageHandler;
}

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: MqttClient | null = null;

  // Registered subscriptions. Re-applied on reconnect so a broker bounce
  // doesn't silently leave the backend deaf to driver location publishes.
  private readonly subscriptions: Subscription[] = [];

  // mqtt.js emits 'error' on every failed reconnect attempt, so an unreachable
  // broker would log identically once per `reconnectPeriod` forever. We log a
  // given message once and stay quiet until it changes or the link recovers.
  private lastErrorMessage: string | null = null;
  private wasConnected = false;

  constructor(@Inject(MQTT_CLIENT) injectedClient: MqttClient) {
    this.client = injectedClient;
  }

  onModuleInit(): void {
    if (!this.client) return;
    this.client.on('connect', () => this.handleConnect());
    // Dispatch incoming messages to every registered handler whose pattern
    // matches the inbound topic. mqtt.js doesn't expose its own pattern
    // matcher, so we do a small wildcard match (+ for single segment, #
    // for trailing). Keep this in sync with broker-side topic rules.
    this.client.on('message', (topic, payload) => {
      for (const sub of this.subscriptions) {
        if (topicMatches(sub.pattern, topic)) {
          try {
            sub.handler(topic, payload);
          } catch {
            /* swallow */
          }
        }
      }
    });
    // A listener is required so reconnect errors aren't logged by Node as
    // "Unhandled error event" and don't crash the process. Beyond that we
    // surface the reason: against a remote broker this is where a bad
    // credential (`Connection refused: Not authorized`), a failed TLS
    // handshake, or an unresolvable host actually shows up.
    this.client.on('error', (err: Error) => {
      const message = err?.message ?? String(err);
      if (message !== this.lastErrorMessage) {
        this.lastErrorMessage = message;
        this.logger.error(`MQTT connection error: ${message}`);
      }
    });

    // Distinguish "the broker closed on us" from "we never got there". Only
    // logged on the transition so a long outage doesn't flood the log.
    this.client.on('close', () => {
      if (this.wasConnected) {
        this.wasConnected = false;
        this.logger.warn('MQTT connection closed — reconnecting');
      }
    });

    // `mqtt.connect()` runs in the DI factory, so the client starts dialling
    // before any of the listeners above exist. A broker that answers inside
    // that window emits 'connect' into the void: the app ends up genuinely
    // connected but never logs it and — worse — never runs the subscribe
    // loop, so inbound driver topics are silently never subscribed. Catch up
    // if the connection already landed.
    if (this.client.connected) {
      this.handleConnect();
    }
  }

  /**
   * Applied on every successful connect, including one that happened before
   * the listeners were attached. Safe to run more than once — re-subscribing
   * an existing subscription is a no-op at the broker.
   */
  private handleConnect(): void {
    // Recovery is worth a line: against a hosted broker this is the only
    // signal that a credential or TLS problem has actually cleared.
    if (this.lastErrorMessage || !this.wasConnected) {
      this.logger.log('Connected to MQTT broker');
    }
    this.lastErrorMessage = null;
    this.wasConnected = true;

    // Re-subscribe everything on every connect so a broker restart doesn't
    // strand handlers. mqtt.js drops server-side subs across sessions when
    // `clean: true`.
    for (const sub of this.subscriptions) {
      this.client?.subscribe(sub.pattern, { qos: 0 }, (err, granted) => {
        // A broker-side ACL denial surfaces here and nowhere else. On a
        // hosted broker the backend credential often lacks permission on
        // `driver/+/location` at first, and without this the API simply
        // never receives driver positions with no indication why.
        if (err) {
          this.logger.error(
            `Failed to subscribe to "${sub.pattern}": ${err.message}`,
          );
          return;
        }
        const denied = (granted ?? []).some((g) => g.qos === 128);
        if (denied) {
          this.logger.error(
            `Broker DENIED subscription to "${sub.pattern}" — check the ACL for this credential`,
          );
          return;
        }
        this.logger.log(`Subscribed to "${sub.pattern}"`);
      });
    }
  }

  /**
   * Whether the client currently holds a live broker session. Mirrors
   * `RedisService.isReady()` so callers (and a future /health endpoint) can
   * report transport state without reading logs.
   */
  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  /**
   * Register a handler for messages matching an MQTT topic pattern (supports
   * `+` single-level and `#` trailing wildcards). The subscription is
   * remembered so it survives broker reconnects. Idempotent per pattern —
   * registering the same pattern twice attaches two handlers.
   */
  subscribe(pattern: string, handler: MqttMessageHandler): void {
    this.subscriptions.push({ pattern, handler });
    if (this.client && this.client.connected) {
      this.client.subscribe(pattern, { qos: 0 });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      // `end()`'s callback is `(err?: Error) => void`; Promise<void>.resolve
      // expects no argument, so wrap to discard the error. Shutdown errors
      // aren't actionable — log and move on either way.
      await new Promise<void>((resolve) =>
        this.client!.end(false, {}, () => resolve()),
      );
    }
  }

  /**
   * Publish a JSON payload to a topic. Fire-and-forget by default (QoS 0) —
   * losing a single bus-position update is harmless because the next tick
   * publishes a fresh one. Pass `{ retain: true }` so new subscribers
   * receive the last known value on subscribe (useful for initial state).
   */
  publish(
    topic: string,
    payload: unknown,
    options: IClientPublishOptions = { qos: 0 },
  ): void {
    if (!this.client || !this.client.connected) return; // drop silently while disconnected
    const body =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.client.publish(topic, body, options);
  }
}

// MQTT topic wildcard match. `+` matches a single level, `#` matches zero or
// more trailing levels. `driver/+/location` matches `driver/abc/location` but
// not `driver/abc/sub/location`; `transit/#` matches anything under transit.
function topicMatches(pattern: string, topic: string): boolean {
  const pp = pattern.split('/');
  const tp = topic.split('/');
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i];
    if (p === '#') return true; // `#` is only valid at the end; consume rest
    if (i >= tp.length) return false;
    if (p === '+') continue;
    if (p !== tp[i]) return false;
  }
  return pp.length === tp.length;
}
