import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  appConfig,
  databaseConfig,
  redisConfig,
  mapConfig,
  mqttConfig,
  envValidationSchema,
} from './config';
import { DatabaseModule } from './shared/database/database.module';
import { RedisModule } from './shared/redis/redis.module';
import { MqttModule } from './shared/mqtt/mqtt.module';
import { PlaceModule } from './modules/places/place.module';
import { TransitModule } from './modules/transit/transit.module';
import { UsersModule } from './modules/users/user.module';
import { SearchHistoryModule } from './modules/search-history/search-history.module';
import { AppSettingsModule } from './modules/app-settings/app-settings.module';
import { MqttAuthModule } from './modules/mqtt-auth/mqtt-auth.module';
import { FavoritesModule } from './modules/favorites/favorites.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, mapConfig, mqttConfig],
      validationSchema: envValidationSchema,
    }),
    DatabaseModule,
    RedisModule,
    MqttModule,
    AppSettingsModule,
    PlaceModule,
    TransitModule,
    UsersModule,
    MqttAuthModule,
    SearchHistoryModule,
    FavoritesModule,
  ],
})
export class AppModule {}
