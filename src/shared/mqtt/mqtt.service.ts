import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IClientPublishOptions, MqttClient } from 'mqtt';
import { MqttConfig } from '../../config/mqtt.config';

export const MQTT_CLIENT = Symbol('MQTT_CLIENT');

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: MqttClient | null = null;

  constructor(
    @Inject(MQTT_CLIENT) injectedClient: MqttClient,
    private readonly configService: ConfigService,
  ) {
    this.client = injectedClient;
  }

  onModuleInit(): void {
    if (!this.client) return;
    this.client.on('connect', () => {
      const { url } = this.configService.get<MqttConfig>('mqtt')!;
      this.logger.log(`Connected to MQTT broker at ${url}`);
    });
    this.client.on('reconnect', () => {
      this.logger.warn('Reconnecting to MQTT broker…');
    });
    // Throttle error logs so a downed broker doesn't flood stdout. Reconnects
    // emit errors continuously on every retry; one log per minute is enough
    // to surface the problem without drowning out everything else.
    let lastLogAt = 0;
    this.client.on('error', (err: Error) => {
      const now = Date.now();
      if (now - lastLogAt > 60_000) {
        lastLogAt = now;
        this.logger.error(`MQTT error: ${err.message}`);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      // `end()`'s callback is `(err?: Error) => void`; Promise<void>.resolve
      // expects no argument, so wrap to discard the error. Shutdown errors
      // aren't actionable — log and move on either way.
      await new Promise<void>((resolve) =>
        this.client!.end(false, {}, () => resolve()),
      );
      this.logger.log('MQTT client disconnected');
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
    this.client.publish(topic, body, options, (err) => {
      if (err) {
        this.logger.warn(
          `MQTT publish to ${topic} failed: ${(err as Error).message}`,
        );
      }
    });
  }
}
