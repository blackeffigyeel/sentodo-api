import { z } from 'zod';
import { RATE_LIMIT_ALGORITHMS, RATE_LIMIT_STORES } from '../rateLimit/rateLimit.types';

/**
 * Parses a comma-separated string into a trimmed, non-empty list.
 * @param {string} value - The raw comma-separated value.
 * @returns {string[]} The parsed values.
 */
const csv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** Coerces common truthy strings ("true", "1", "yes") into a boolean. */
const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['true', '1', 'yes'].includes(value.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3208),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  CORS_ORIGINS: z.string().default('*'),

  DATABASE_URL: z.string().min(1),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(3600),
  ADMIN_SERVICE_TOKEN: z.string().min(16, 'ADMIN_SERVICE_TOKEN must be at least 16 characters'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanFromString.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Sentodo MFB <no-reply@sentodo.example>'),

  /** Mock phone OTP list: any code in this list verifies a phone number. */
  MOCK_PHONE_CODES: z.string().default('123456,654321,246810,135790'),
  VERIFICATION_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  RATE_LIMIT_ALGORITHM: z.enum(RATE_LIMIT_ALGORITHMS).default('token-bucket'),
  RATE_LIMIT_STORE: z.enum(RATE_LIMIT_STORES).default('redis'),

  SANDBOX_FUNDING_ENABLED: booleanFromString.default(false),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),
});

/** Strongly typed, validated application configuration. */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  trustProxy: number;
  corsOrigins: string[];
  databaseUrl: string;
  mongodbUri: string;
  redisUrl: string;
  jwtSecret: string;
  jwtExpiresInSeconds: number;
  adminServiceToken: string;
  smtp: {
    host?: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
  };
  mockPhoneCodes: string[];
  verificationCodeTtlSeconds: number;
  verificationMaxAttempts: number;
  rateLimit: {
    algorithm: (typeof RATE_LIMIT_ALGORITHMS)[number];
    store: (typeof RATE_LIMIT_STORES)[number];
  };
  sandboxFundingEnabled: boolean;
  queueConcurrency: number;
}

/**
 * Validates environment variables and maps them into a typed configuration object.
 * Fails fast with a readable message if anything is missing or malformed.
 * @param {NodeJS.ProcessEnv} [source=process.env] - The environment to read from.
 * @returns {AppConfig} The validated configuration.
 * @throws {Error} If validation fails.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const env = parsed.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    corsOrigins: csv(env.CORS_ORIGINS),
    databaseUrl: env.DATABASE_URL,
    mongodbUri: env.MONGODB_URI,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    jwtExpiresInSeconds: env.JWT_EXPIRES_IN_SECONDS,
    adminServiceToken: env.ADMIN_SERVICE_TOKEN,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.MAIL_FROM,
    },
    mockPhoneCodes: csv(env.MOCK_PHONE_CODES).filter((code) => /^\d{6}$/.test(code)),
    verificationCodeTtlSeconds: env.VERIFICATION_CODE_TTL_SECONDS,
    verificationMaxAttempts: env.VERIFICATION_MAX_ATTEMPTS,
    rateLimit: { algorithm: env.RATE_LIMIT_ALGORITHM, store: env.RATE_LIMIT_STORE },
    sandboxFundingEnabled: env.SANDBOX_FUNDING_ENABLED,
    queueConcurrency: env.QUEUE_CONCURRENCY,
  };
}
