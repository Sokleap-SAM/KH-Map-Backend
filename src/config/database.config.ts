import { registerAs } from '@nestjs/config';

export interface DatabaseConfig {
  uri: string;
}

export const databaseConfig = registerAs(
  'database',
  (): DatabaseConfig => ({
    uri: process.env.MONGODB_URI!,
  }),
);
