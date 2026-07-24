import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Injectable()
export class RedisService {
  constructor(@Inject(REDIS_CLIENT) private readonly redisClient: Redis) {}

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
    } catch {
      /* swallow */
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
    } catch {
      return null;
    }
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<void> {
    try {
      await this.redisClient.del(key);
    } catch {
      /* swallow */
    }
  }

  /**
   * Delete every key matching a glob pattern, in batches. Uses SCAN to avoid
   * blocking Redis on `KEYS *`-style queries against a large keyspace.
   * Intended for dev/admin resets — not a hot-path operation.
   */
  async deleteByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    try {
      do {
        const [next, keys] = await this.redisClient.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          200,
        );
        cursor = next;
        if (keys.length > 0) {
          deleted += await this.redisClient.del(...keys);
        }
      } while (cursor !== '0');
    } catch {
      /* swallow */
    }
    return deleted;
  }

  // ─── Hash operations ───────────────────────────────────────

  async hset(key: string, data: Record<string, string>): Promise<void> {
    try {
      await this.redisClient.hset(key, data);
    } catch {
      /* swallow */
    }
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    try {
      const data = await this.redisClient.hgetall(key);
      if (!data || Object.keys(data).length === 0) return null;
      return data;
    } catch {
      return null;
    }
  }

  async hdel(key: string): Promise<void> {
    try {
      await this.redisClient.del(key);
    } catch {
      /* swallow */
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
    } catch {
      /* swallow */
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
    } catch {
      return [];
    }
  }

  async geopos(key: string, member: string): Promise<[string, string] | null> {
    try {
      const result = await this.redisClient.geopos(key, member);
      if (!result || !result[0]) return null;
      return result[0] as [string, string];
    } catch {
      return null;
    }
  }

  async georemove(key: string, member: string): Promise<void> {
    try {
      await this.redisClient.zrem(key, member);
    } catch {
      /* swallow */
    }
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redisClient.expire(key, ttlSeconds);
  }

  /**
   * Set a plain string key only if it does not already exist (NX).
   * Returns true if the key was set (lock acquired), false otherwise — either
   * because the key already existed OR because Redis was unreachable.
   * Callers that need to distinguish those (e.g. retry vs. step aside) should
   * check `isReady()` before / after.
   */
  async setnx(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      const result = await this.redisClient.set(
        key,
        value,
        'EX',
        ttlSeconds,
        'NX',
      );
      return result === 'OK';
    } catch {
      return false;
    }
  }

  /**
   * Whether the underlying ioredis client is currently connected and ready to
   * accept commands. Useful for callers that need to retry until the
   * connection comes up (e.g. simulator start at boot).
   */
  isReady(): boolean {
    return this.redisClient.status === 'ready';
  }
}
