import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { IssueContext } from '../linear/types.js';
import type { ClaudeTaskResult } from '../claude/executor.js';
import { buildPrompt, parseClaudeOutput } from '../claude/executor.js';
import type { ComputeProvider } from './types.js';

/**
 * Local compute provider - runs Claude Code directly on the host machine
 */
export class LocalComputeProvider implements ComputeProvider {
  name = 'local';

  async executeTask(context: IssueContext): Promise<ClaudeTaskResult> {
    const { repository } = context;

    const taskId = uuidv4();
    const workDir = path.join(config.WORK_DIR, taskId);

    logger.info(`[local] Starting task ${taskId} in ${workDir}`);

    try {
      await fs.mkdir(workDir, { recursive: true });

      let repoDir = workDir;

      // Clone the repository if one is configured
      if (repository) {
        logger.info(`[local] Cloning ${repository.url}`);
        await this.runCommand('git', ['clone', repository.url, 'repo'], { cwd: workDir });

        repoDir = path.join(workDir, 'repo');

        // Configure git
        await this.runCommand('git', ['config', 'user.email', 'claude@linear-webhook.local'], { cwd: repoDir });
        await this.runCommand('git', ['config', 'user.name', 'Claude (Linear Webhook)'], { cwd: repoDir });

        // Set up credentials for pushing
        await this.runCommand('git', ['remote', 'set-url', 'origin',
          `https://x-access-token:${config.GITHUB_TOKEN}@github.com/${repository.owner}/${repository.name}.git`
        ], { cwd: repoDir });
      } else {
        logger.info('[local] No repository configured, running in standalone mode');
      }

      const prompt = buildPrompt(context);
      await fs.writeFile(path.join(workDir, 'prompt.txt'), prompt);

      // Execute Claude Code
      logger.info('[local] Executing Claude Code CLI');
      const claudeOutput = await this.runClaudeCode(repoDir, prompt);
      const result = parseClaudeOutput(claudeOutput);

      if (result.success) {
        logger.info(`[local] Task ${taskId} completed successfully`);
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      } else {
        logger.warn(`[local] Task ${taskId} failed: ${result.error}`);
      }

      return result;

    } catch (error) {
      logger.error(`[local] Task ${taskId} error`, { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private runCommand(
    command: string,
    args: string[],
    options: { cwd?: string } = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private runClaudeCode(workDir: string, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--dangerously-skip-permissions',
        '--max-turns', config.CLAUDE_MAX_TURNS.toString(),
        prompt,
      ];

      if (config.CLAUDE_MODEL) {
        args.unshift('--model', config.CLAUDE_MODEL);
      }

      logger.debug('[local] Running claude with args', { args: args.slice(0, -1) });

      const claudeEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        CI: 'true',
      };
      if (config.ANTHROPIC_API_KEY) {
        claudeEnv.ANTHROPIC_API_KEY = config.ANTHROPIC_API_KEY;
      }

      const proc = spawn('claude', args, {
        cwd: workDir,
        env: claudeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],  // stdin must be ignored or claude hangs
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        text.split('\n').forEach((line: string) => {
          if (line.trim()) {
            logger.debug(`[claude] ${line}`);
          }
        });
      });

      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('Claude Code timed out after 30 minutes'));
      }, 30 * 60 * 1000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout);
        } else {
          logger.error('[local] Claude Code failed', { stderr, code });
          resolve(stdout);
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
