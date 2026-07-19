import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisConfig } from '../../config/redis.config';
import { RedisService, REDIS_CLIENT } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { host, port, password } =
          configService.get<RedisConfig>('redis')!;
        const client = new Redis({
          host,
          port,
          password,
          // Fail fast when Redis is unreachable so HTTP handlers don't block
          // on the default 20-retry loop. RedisService catches the resulting
          // errors and returns safe defaults.
          tls: host.includes('redis') ? undefined : {},
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          retryStrategy: (times) => Math.min(times * 1000, 30_000),
        });
        // ioredis emits 'error' for every reconnect attempt; without a
        // listener Node logs each one as an "Unhandled error event". Swallow
        // so a downed Redis doesn't crash the process.
        client.on('error', () => {});
        return client;
      },
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}

export { REDIS_CLIENT };
