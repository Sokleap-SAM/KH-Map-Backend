import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from './config';
import { ValidationPipe } from '@nestjs/common';
import { configureCloudinary } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  configureCloudinary();

  const configService = app.get(ConfigService);
  const { port, corsOrigins } = configService.get<AppConfig>('app')!;

  // `*` is an explicit opt-in to any origin, and the only value production
  // accepts besides a real allowlist — the env schema rejects a blank one, so
  // running wide open is always a stated choice rather than an oversight.
  //
  // Note `credentials` is deliberately NOT set in the wildcard case: browsers
  // reject `Access-Control-Allow-Origin: *` on credentialed requests, so
  // sending both would break every call instead of loosening anything.
  const allowAnyOrigin = corsOrigins.length === 0 || corsOrigins.includes('*');
  app.enableCors(
    allowAnyOrigin ? undefined : { origin: corsOrigins, credentials: true },
  );
  if (allowAnyOrigin && process.env.NODE_ENV === 'production') {
    // Worth a line in CloudWatch: this is fine for token-authenticated
    // clients, but it should not be how the admin dashboard ships long-term.
    console.warn(
      'CORS: all origins allowed (CORS_ORIGINS=*). Narrow this once the ' +
        'browser clients have fixed domains.',
    );
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Without this, Nest never runs onModuleDestroy on SIGTERM — which ECS
  // sends before SIGKILL on every rolling deploy. The simulator would leave
  // its Redis lock to expire on TTL (a window where no instance simulates)
  // and the MQTT client would never disconnect cleanly.
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');
  console.log(`Server is running on ${port}`);
}
bootstrap();
