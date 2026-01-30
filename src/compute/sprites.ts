import { spawn } from 'child_process';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { IssueContext } from '../linear/types.js';
import type { ClaudeTaskResult } from '../claude/executor.js';
import { buildPrompt, parseClaudeOutput } from '../claude/executor.js';
import type { ComputeProvider } from './types.js';

/**
 * Sprites compute provider - runs Claude Code in Fly.io Sprites using the CLI
 * https://sprites.dev/
 */
export class SpritesComputeProvider implements ComputeProvider {
  name = 'sprites';

  async executeTask(context: IssueContext): Promise<ClaudeTaskResult> {
    const { repository, issue } = context;

    if (!repository) {
      return {
        success: false,
        error: 'No repository configured',
      };
    }

    // Create a unique sprite name for this task
    const spriteName = `linear-${issue.identifier.toLowerCase()}-${Date.now()}`;

    logger.info(`[sprites] Creating sprite ${spriteName}`);

    try {
      // Create the sprite
      await this.spriteExec(['create', spriteName]);

      // Set up git
      await this.spriteExec(['exec', '-s', spriteName, 'git', 'config', '--global', 'user.email', 'claude@linear-webhook.local']);
      await this.spriteExec(['exec', '-s', spriteName, 'git', 'config', '--global', 'user.name', 'Claude (Linear Webhook)']);

      // Clone the repository with credentials
      const cloneUrl = `https://x-access-token:${config.GITHUB_TOKEN}@github.com/${repository.owner}/${repository.name}.git`;
      logger.info(`[sprites] Cloning ${repository.url}`);
      await this.spriteExec(['exec', '-s', spriteName, 'git', 'clone', cloneUrl, '/workspace']);

      // Build the prompt and write to file
      const prompt = buildPrompt(context);

      // Write prompt to a temp file, then copy to sprite
      const promptFile = `/tmp/sprite-prompt-${Date.now()}.txt`;
      const fs = await import('fs/promises');
      await fs.writeFile(promptFile, prompt);

      // Copy prompt file to sprite using stdin
      await this.spriteExec(['exec', '-s', spriteName, 'tee', '/workspace/prompt.txt'], prompt);
      await fs.unlink(promptFile).catch(() => {});

      // Build Claude command
      let claudeArgs = ['--print', '--dangerously-skip-permissions'];
      claudeArgs.push('--max-turns', config.CLAUDE_MAX_TURNS.toString());
      if (config.CLAUDE_MODEL) {
        claudeArgs.push('--model', config.CLAUDE_MODEL);
      }

      // Build environment prefix
      const envVars: string[] = ['CI=true'];
      if (config.ANTHROPIC_API_KEY) {
        envVars.push(`ANTHROPIC_API_KEY=${config.ANTHROPIC_API_KEY}`);
      }

      // Execute Claude Code in the sprite
      logger.info('[sprites] Executing Claude Code');
      const claudeCmd = `cd /workspace && ${envVars.join(' ')} claude ${claudeArgs.join(' ')} "$(cat /workspace/prompt.txt)"`;

      const claudeOutput = await this.spriteExec(
        ['exec', '-s', spriteName, 'bash', '-c', claudeCmd],
        undefined,
        30 * 60 * 1000 // 30 minute timeout
      );

      logger.debug('[sprites] Claude output received', { length: claudeOutput.length });

      // Parse the result
      const taskResult = parseClaudeOutput(claudeOutput);

      if (taskResult.success) {
        logger.info(`[sprites] Task completed successfully on sprite ${spriteName}`);
      } else {
        logger.warn(`[sprites] Task failed on sprite ${spriteName}: ${taskResult.error}`);
      }

      // Clean up the sprite
      await this.deleteSprite(spriteName);

      return taskResult;

    } catch (error) {
      logger.error(`[sprites] Task error on sprite ${spriteName}`, { error });

      // Try to clean up on error
      await this.deleteSprite(spriteName);

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async deleteSprite(name: string): Promise<void> {
    try {
      await this.spriteExec(['delete', name, '--force']);
      logger.debug(`[sprites] Deleted sprite ${name}`);
    } catch (error) {
      logger.warn(`[sprites] Failed to delete sprite ${name}`, { error });
    }
  }

  private spriteExec(args: string[], stdin?: string, timeout = 60000): Promise<string> {
    return new Promise((resolve, reject) => {
      logger.debug('[sprites] Running sprite command', { args: args.slice(0, 4) });

      const proc = spawn('sprite', args, {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        text.split('\n').forEach((line: string) => {
          if (line.trim()) {
            logger.debug(`[sprite] ${line}`);
          }
        });
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      if (stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Sprite command timed out after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Sprite command failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}
