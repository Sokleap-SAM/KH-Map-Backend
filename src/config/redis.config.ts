import { registerAs } from '@nestjs/config';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  /**
   * Whether to connect over TLS. Explicit rather than inferred from the
   * hostname: an ElastiCache endpoint is commonly named something like
   * `khmap-redis.xxx.cache.amazonaws.com`, so a substring test for "redis"
   * would silently disable TLS against an encrypted cluster.
   */
  tls: boolean;
}

export const redisConfig = registerAs('redis', (): RedisConfig => ({
  host: process.env.REDIS_HOST!,
  port: parseInt(process.env.REDIS_PORT!, 10) || 6379,
  password: process.env.REDIS_PASSWORD!,
  // Default false — only an explicit "true" opts in, matching mqtt.config.ts.
  tls: process.env.REDIS_TLS === 'true',
}));
