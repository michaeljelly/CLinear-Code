import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { IssueContext } from '../linear/types.js';

export interface ClaudeTaskResult {
  success: boolean;
  output: string;
  prUrl?: string;
  error?: string;
}

/**
 * Build the prompt for Claude Code
 */
export function buildPrompt(context: IssueContext): string {
  const { issue, comments, triggerComment, repository } = context;

  const branchName = issue.branchName || `${issue.teamKey?.toLowerCase() || 'feature'}/${issue.identifier.toLowerCase()}`;

  let prompt = `# Task from Linear: ${issue.identifier}

**${issue.title}**

${issue.description || '(No description)'}

## Request
${triggerComment.instruction}

`;

  // Add recent comments for context (skip auto-generated ones)
  const relevantComments = comments.filter(c =>
    !c.body.includes('Claude is on it') &&
    !c.body.includes('Task Complete') &&
    !c.body.includes('Task Failed')
  );
  if (relevantComments.length > 0) {
    prompt += `## Comments\n`;
    relevantComments.slice(-3).forEach(c => {
      prompt += `- ${c.author}: ${c.body.substring(0, 300)}${c.body.length > 300 ? '...' : ''}\n`;
    });
    prompt += '\n';
  }

  // Different instructions based on whether we have a repo
  if (repository) {
    prompt += `## Instructions
This is a coding task. You're in a git repo (${repository.owner}/${repository.name}).

1. Create branch: \`${branchName}\`
2. Make the changes requested
3. Commit, push, and create a PR titled "[${issue.identifier}] ${issue.title}"
`;
  } else {
    prompt += `## Instructions
Complete the task requested above.
`;
  }

  return prompt;
}

/**
 * Parse Claude's output to extract PR URL if present
 */
export function parseClaudeOutput(output: string): ClaudeTaskResult {
  // Try to find PR URL in output
  const prUrlMatch = output.match(/https:\/\/github\.com\/[^\s\)]+\/pull\/\d+/);

  return {
    success: true,
    output: output,
    prUrl: prUrlMatch ? prUrlMatch[0] : undefined,
  };
}

/**
 * Execute Claude Code CLI to implement the task
 * Note: This function is kept for compatibility but LocalComputeProvider is preferred
 */
export async function executeClaudeTask(context: IssueContext): Promise<ClaudeTaskResult> {
  const { repository } = context;

  if (!repository) {
    return {
      success: false,
      output: '',
      error: 'No repository configured',
    };
  }

  const taskId = uuidv4();
  const workDir = path.join(config.WORK_DIR, taskId);

  logger.info(`Starting Claude task ${taskId} in ${workDir}`);

  try {
    await fs.mkdir(workDir, { recursive: true });

    logger.info(`Cloning ${repository.url}`);
    await runCommand('git', ['clone', repository.url, 'repo'], { cwd: workDir });

    const repoDir = path.join(workDir, 'repo');

    await runCommand('git', ['config', 'user.email', 'claude@linear-webhook.local'], { cwd: repoDir });
    await runCommand('git', ['config', 'user.name', 'Claude (Linear Webhook)'], { cwd: repoDir });
    await runCommand('git', ['remote', 'set-url', 'origin',
      `https://x-access-token:${config.GITHUB_TOKEN}@github.com/${repository.owner}/${repository.name}.git`
    ], { cwd: repoDir });

    const prompt = buildPrompt(context);
    await fs.writeFile(path.join(workDir, 'prompt.txt'), prompt);

    logger.info('Executing Claude Code CLI');
    const claudeOutput = await runClaudeCode(repoDir, prompt);
    const result = parseClaudeOutput(claudeOutput);

    if (result.success) {
      logger.info(`Task ${taskId} completed successfully`);
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    return result;

  } catch (error) {
    logger.error(`Task ${taskId} error`, { error });
    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function runCommand(
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

function runClaudeCode(workDir: string, prompt: string): Promise<string> {
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

    logger.debug('Running claude with args', { args: args.slice(0, -1) });

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
      stdio: ['ignore', 'pipe', 'pipe'],
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
        logger.error('Claude Code failed', { stderr, code });
        resolve(stdout); // Still return output even on failure
      }
    });

    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
