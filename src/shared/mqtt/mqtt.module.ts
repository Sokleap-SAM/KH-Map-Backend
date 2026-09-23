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
        const {
          url,
          username,
          password,
          clientId,
          keepalive,
          rejectUnauthorized,
          ca,
        } = configService.get<MqttConfig>('mqtt')!;

        // TLS options only apply to mqtts:// and wss://. Passing them on a
        // plain mqtt:// dev connection is a no-op, but scoping them keeps the
        // local setup provably unchanged.
        const isTls = url.startsWith('mqtts://') || url.startsWith('wss://');

        // `mqtt.connect` returns the client immediately and reconnects
        // forever by default. MqttService attaches lifecycle listeners in
        // onModuleInit so connection state is visible in the logs — important
        // against a hosted broker, where a rejected credential or a failed TLS
        // handshake is otherwise indistinguishable from silence.
        return mqtt.connect(url, {
          username,
          password,
          clientId,
          clean: true,
          reconnectPeriod: 5_000,
          connectTimeout: 10_000,
          keepalive,
          ...(isTls ? { rejectUnauthorized, ...(ca ? { ca: [ca] } : {}) } : {}),
        });
      },
    },
    MqttService,
  ],
  exports: [MqttService],
})
export class MqttModule {}
