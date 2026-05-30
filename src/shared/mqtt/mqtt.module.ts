import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mqtt from 'mqtt';
import { MqttConfig } from '../../config/mqtt.config';
import { MqttService, MQTT_CLIENT } from './mqtt.service';

@Global()
@Module({
  providers: [
    {
      provide: MQTT_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { url, username, password, clientId } =
          configService.get<MqttConfig>('mqtt')!;
        // `mqtt.connect` returns the client immediately and reconnects
        // forever by default. The MqttService attaches lifecycle listeners
        // in onModuleInit so connection state is visible in the logs.
        return mqtt.connect(url, {
          username,
          password,
          clientId,
          clean: true,
          reconnectPeriod: 5_000,
          connectTimeout: 10_000,
        });
      },
    },
    MqttService,
  ],
  exports: [MqttService],
})
export class MqttModule {}
