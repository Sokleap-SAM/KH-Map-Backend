import { Injectable, Inject, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private lastWarnAt = 0;

  constructor(@Inject(REDIS_CLIENT) private readonly redisClient: Redis) {}

  // Warns at most once every 30 s so a downed Redis doesn't flood the log.
  private warnUnavailable(op: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt > 30_000) {
      this.lastWarnAt = now;
      this.logger.warn(
        `Redis unavailable during ${op}: ${(err as Error).message}. Returning degraded result.`,
      );
    }
  }

  /**
   * Set a key-value pair in Redis
   * @param key String key
   * @param value String or Object value
   * @param ttl Optional time to live in seconds
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const stringifiedValue = JSON.stringify(value);
    try {
      if (ttl) {
        await this.redisClient.set(key, stringifiedValue, 'EX', ttl);
      } else {
        await this.redisClient.set(key, stringifiedValue);
      }
    } catch (err) {
      this.warnUnavailable('set', err);
    }
  }

  /**
   * Get a value from Redis by key
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.redisClient.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (err) {
      this.warnUnavailable('get', err);
      return null;
    }
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<void> {
    try {
      await this.redisClient.del(key);
    } catch (err) {
      this.warnUnavailable('del', err);
    }
  }

  // ─── Hash operations ───────────────────────────────────────

  async hset(key: string, data: Record<string, string>): Promise<void> {
    try {
      await this.redisClient.hset(key, data);
    } catch (err) {
      this.warnUnavailable('hset', err);
    }
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    try {
      const data = await this.redisClient.hgetall(key);
      if (!data || Object.keys(data).length === 0) return null;
      return data;
    } catch (err) {
      this.warnUnavailable('hgetall', err);
      return null;
    }
  }

  async hdel(key: string): Promise<void> {
    try {
      await this.redisClient.del(key);
    } catch (err) {
      this.warnUnavailable('hdel', err);
    }
  }

  // ─── Geo operations (for bus locations) ────────────────────

  async geoadd(
    key: string,
    longitude: number,
    latitude: number,
    member: string,
  ): Promise<void> {
    try {
      await this.redisClient.geoadd(key, longitude, latitude, member);
    } catch (err) {
      this.warnUnavailable('geoadd', err);
    }
  }

  async geosearch(
    key: string,
    longitude: number,
    latitude: number,
    radiusMeters: number,
  ): Promise<string[]> {
    try {
      const result = await this.redisClient.geosearch(
        key,
        'FROMLONLAT',
        longitude,
        latitude,
        'BYRADIUS',
        radiusMeters,
        'm',
        'ASC',
      );
      return result as string[];
    } catch (err) {
      this.warnUnavailable('geosearch', err);
      return [];
    }
  }

  async geopos(key: string, member: string): Promise<[string, string] | null> {
    try {
      const result = await this.redisClient.geopos(key, member);
      if (!result || !result[0]) return null;
      return result[0] as [string, string];
    } catch (err) {
      this.warnUnavailable('geopos', err);
      return null;
    }
  }

  async georemove(key: string, member: string): Promise<void> {
    try {
      await this.redisClient.zrem(key, member);
    } catch (err) {
      this.warnUnavailable('georemove', err);
    }
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redisClient.expire(key, ttlSeconds);
  }

  /**
   * Set a plain string key only if it does not already exist (NX).
   * Returns true if the key was set (lock acquired), false if it already existed.
   */
  async setnx(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redisClient.set(
      key,
      value,
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }
}
