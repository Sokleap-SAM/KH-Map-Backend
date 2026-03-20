import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisConfig } from '../../config/redis.config';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { host, port, password } =
          configService.get<RedisConfig>('redis')!;
        return new Redis({ host, port, password });
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
