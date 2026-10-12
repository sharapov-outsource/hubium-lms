import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url().default('http://localhost:3000'),
  /** Separate origin for untrusted content (SCORM); defaults to APP_URL in development. */
  CONTENT_HOST: z.string().url().optional(),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  STORAGE_FS_ROOT: z.string().default('.storage'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_URL: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('hubium'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  MAIL_FROM: z.string().default('Hubium <no-reply@hubium.local>'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parses process.env once. Throws a readable error listing every invalid variable. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}
