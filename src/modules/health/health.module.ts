import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

// RedisModule is @Global and MongooseModule's core module is too, so the
// controller's dependencies need no explicit imports here.
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
