import { registerAs } from '@nestjs/config';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  /**
   * Allowed CORS origins, parsed from the comma-separated CORS_ORIGINS.
   *
   * Empty, or a single `*`, means any origin. The env schema rejects a blank
   * value in production, so wide-open CORS there is always deliberate: you
   * have to write `*`. That is a defensible setting for this API — auth is a
   * Bearer token in a header rather than a cookie, and CORS does nothing for
   * the mobile clients anyway — but it should narrow once the browser-based
   * admin dashboard has a fixed domain.
   */
  corsOrigins: string[];
}

export const appConfig = registerAs('app', (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.CONTAINER_PORT!, 10) || 3000,
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
}));
