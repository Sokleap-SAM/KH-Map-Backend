import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  appConfig,
  databaseConfig,
  redisConfig,
  mapConfig,
  envValidationSchema,
} from './config';
import { DatabaseModule } from './shared/database/database.module';
import { RedisModule } from './shared/redis/redis.module';
import { PlaceModule } from './modules/places/place.module';
import { TransitModule } from './modules/transit/transit.module';
import { UsersModule } from './modules/users/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, mapConfig],
      validationSchema: envValidationSchema,
    }),
    DatabaseModule,
    RedisModule,
    PlaceModule,
    TransitModule,
    UsersModule,
  ],
})
export class AppModule {}
