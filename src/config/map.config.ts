import { registerAs } from '@nestjs/config';

export interface MapConfig {
  apiKey: string;
}

export const mapConfig = registerAs(
  'map',
  (): MapConfig => ({
    apiKey: process.env.MAP_API_KEY!,
  }),
);
