import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ConnectionStates } from 'mongoose';
import { RedisService } from '../../shared/redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    private readonly redis: RedisService,
  ) {}

  /**
   * Liveness — the load balancer's probe. Deliberately does no I/O: if this
   * failed whenever a dependency blipped, the target group would drain tasks
   * that are still perfectly able to serve traffic, turning a brief Mongo
   * hiccup into an outage.
   */
  @Get()
  live() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /**
   * Readiness — dependency state for smoke tests and humans. NOT wired to the
   * load balancer, for the reason above. Returns 503 when degraded so
   * `curl -f` is meaningful in a deploy script.
   */
  @Get('ready')
  ready() {
    // Mongoose reconnects on its own, so a non-connected state here is a
    // point-in-time reading, not necessarily a permanent failure.
    const mongoUp = this.mongo.readyState === ConnectionStates.connected;
    const redisUp = this.redis.isReady();

    const body = {
      status: mongoUp && redisUp ? 'ok' : 'degraded',
      mongo: mongoUp ? 'up' : 'down',
      redis: redisUp ? 'up' : 'down',
    };

    if (!mongoUp || !redisUp) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
