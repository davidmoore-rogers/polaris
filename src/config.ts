/**
 * src/config.ts — Centralised application configuration
 */

export const config = {
  port:         parseInt(process.env.PORT ?? "3000", 10),
  nodeEnv:      process.env.NODE_ENV ?? "development",
  logLevel:     process.env.LOG_LEVEL ?? "info",
  databaseUrl:  process.env.DATABASE_URL ?? "",
  apiKeySecret: process.env.API_KEY_SECRET,
  jwtSecret:    process.env.JWT_SECRET,
} as const;
