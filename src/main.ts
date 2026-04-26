import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from './config';
import { ValidationPipe } from '@nestjs/common';
import { configureCloudinary } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  configureCloudinary();

  app.enableCors();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const configService = app.get(ConfigService);
  const { port } = configService.get<AppConfig>('app')!;

  await app.listen(port, '0.0.0.0');
  console.log(`Server is running on ${port}`);
}
bootstrap();
