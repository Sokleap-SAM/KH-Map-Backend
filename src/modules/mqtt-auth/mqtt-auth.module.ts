import { Module } from '@nestjs/common';
import { MqttAuthController } from './mqtt-auth.controller';
import { UsersModule } from '../users/user.module';

@Module({
  imports: [UsersModule],
  controllers: [MqttAuthController],
})
export class MqttAuthModule {}
