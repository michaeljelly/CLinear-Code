import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  // Server configuration
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('0.0.0.0'),

  // Linear configuration
  LINEAR_API_KEY: z.string().min(1, 'LINEAR_API_KEY is required'),
  LINEAR_WEBHOOK_SECRET: z.string().optional(),
  LINEAR_TEAM_ID: z.string().optional(),

  // GitHub configuration
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  GITHUB_DEFAULT_REPO: z.string().optional(),

  // Claude configuration
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-20250514'),
  CLAUDE_MAX_TURNS: z.string().default('200').transform(Number),

  // Compute provider
  COMPUTE_PROVIDER: z.enum(['local', 'fly', 'cloudflare', 'modal']).default('local'),
  WORK_DIR: z.string().default('/tmp/claude-work'),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = z.infer<typeof configSchema>;
