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
    if (ttl) {
      await this.redisClient.set(key, stringifiedValue, 'EX', ttl);
    } else {
      await this.redisClient.set(key, stringifiedValue);
    }
  }

  /**
   * Get a value from Redis by key
   */
  async get<T>(key: string): Promise<T | null> {
    const data = await this.redisClient.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<void> {
    await this.redisClient.del(key);
  }

  // ─── Hash operations ───────────────────────────────────────

  async hset(key: string, data: Record<string, string>): Promise<void> {
    await this.redisClient.hset(key, data);
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const data = await this.redisClient.hgetall(key);
    if (!data || Object.keys(data).length === 0) return null;
    return data;
  }

  async hdel(key: string): Promise<void> {
    await this.redisClient.del(key);
  }

  // ─── Geo operations (for bus locations) ────────────────────

  async geoadd(
    key: string,
    longitude: number,
    latitude: number,
    member: string,
  ): Promise<void> {
    await this.redisClient.geoadd(key, longitude, latitude, member);
  }

  async geosearch(
    key: string,
    longitude: number,
    latitude: number,
    radiusMeters: number,
  ): Promise<string[]> {
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
  }

  async geopos(
    key: string,
    member: string,
  ): Promise<[string, string] | null> {
    const result = await this.redisClient.geopos(key, member);
    if (!result || !result[0]) return null;
    return result[0] as [string, string];
  }

  async georemove(key: string, member: string): Promise<void> {
    await this.redisClient.zrem(key, member);
  }
}
