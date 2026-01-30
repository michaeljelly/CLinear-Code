import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { IssueContext } from '../linear/types.js';

export interface ClaudeTaskResult {
  success: boolean;
  branch?: string;
  prUrl?: string;
  summary?: string;
  assumptions?: string[];
  questions?: string[];
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
  const relevantComments = comments.filter(c => !c.body.includes('Claude is on it'));
  if (relevantComments.length > 0) {
    prompt += `## Comments\n`;
    relevantComments.slice(-3).forEach(c => {
      prompt += `- ${c.author}: ${c.body.substring(0, 200)}${c.body.length > 200 ? '...' : ''}\n`;
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
4. Output result as JSON (see below)
`;
  } else {
    prompt += `## Instructions
Complete the task requested above. When done, output result as JSON (see below).
`;
  }

  prompt += `
## Output Format
When finished, output exactly:
\`\`\`json
{"success": true, "summary": "what you did"${repository ? ', "prUrl": "https://..."' : ''}}
\`\`\`
Or on failure:
\`\`\`json
{"success": false, "error": "what went wrong"}
\`\`\`
`;

  return prompt;
}

/**
 * Execute Claude Code CLI to implement the task
 */
export async function executeClaudeTask(context: IssueContext): Promise<ClaudeTaskResult> {
  const { repository } = context;

  if (!repository) {
    return {
      success: false,
      error: 'No repository configured',
    };
  }

  const taskId = uuidv4();
  const workDir = path.join(config.WORK_DIR, taskId);

  logger.info(`Starting Claude task ${taskId} in ${workDir}`);

  try {
    // Create work directory
    await fs.mkdir(workDir, { recursive: true });

    // Clone the repository
    logger.info(`Cloning ${repository.url}`);
    await runCommand('git', ['clone', repository.url, 'repo'], { cwd: workDir });

    const repoDir = path.join(workDir, 'repo');

    // Configure git with GitHub token for pushing
    await runCommand('git', ['config', 'user.email', 'claude@linear-webhook.local'], { cwd: repoDir });
    await runCommand('git', ['config', 'user.name', 'Claude (Linear Webhook)'], { cwd: repoDir });

    // Set up credential helper
    const gitCredentialUrl = `https://x-access-token:${config.GITHUB_TOKEN}@github.com`;
    await runCommand('git', ['config', 'credential.helper', 'store'], { cwd: repoDir });
    await runCommand('git', ['remote', 'set-url', 'origin',
      `https://x-access-token:${config.GITHUB_TOKEN}@github.com/${repository.owner}/${repository.name}.git`
    ], { cwd: repoDir });

    // Build the prompt
    const prompt = buildPrompt(context);

    // Write prompt to file for reference
    await fs.writeFile(path.join(workDir, 'prompt.txt'), prompt);

    // Execute Claude Code
    logger.info('Executing Claude Code CLI');
    const claudeOutput = await runClaudeCode(repoDir, prompt);

    // Parse the result from Claude's output
    const result = parseClaudeOutput(claudeOutput);

    // Clean up work directory
    if (result.success) {
      logger.info(`Task ${taskId} completed successfully`);
    } else {
      logger.warn(`Task ${taskId} failed: ${result.error}`);
    }

    // Keep work directory for debugging if failed
    if (result.success) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    return result;

  } catch (error) {
    logger.error(`Task ${taskId} error`, { error });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Run a command and return its output
 */
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

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Run Claude Code CLI with the given prompt
 */
function runClaudeCode(workDir: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',  // Non-interactive mode, print output
      '--dangerously-skip-permissions',  // Auto-approve all actions
      '--max-turns', config.CLAUDE_MAX_TURNS.toString(),
      prompt,
    ];

    // Add model if specified
    if (config.CLAUDE_MODEL) {
      args.unshift('--model', config.CLAUDE_MODEL);
    }

    logger.debug('Running claude with args', { args: args.slice(0, -1) }); // Don't log full prompt

    // Build environment - only include ANTHROPIC_API_KEY if explicitly set
    // Otherwise, Claude CLI will use credentials from `claude login`
    const claudeEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      CI: 'true', // Disable interactive features
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
      // Stream output to logs for visibility
      text.split('\n').forEach((line: string) => {
        if (line.trim()) {
          logger.debug(`[claude] ${line}`);
        }
      });
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Set a timeout (30 minutes max)
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
        // Still try to parse output even on non-zero exit
        resolve(stdout);
      }
    });

    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Parse Claude's output to extract the result JSON
 */
export function parseClaudeOutput(output: string): ClaudeTaskResult {
  // Look for JSON block in the output
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);

  if (jsonMatch) {
    try {
      const result = JSON.parse(jsonMatch[1]);
      return {
        success: result.success ?? false,
        branch: result.branch,
        prUrl: result.prUrl,
        summary: result.summary,
        assumptions: result.assumptions,
        questions: result.questions,
        error: result.error,
      };
    } catch (error) {
      logger.warn('Failed to parse Claude output JSON', { error });
    }
  }

  // Try to find PR URL in output
  const prUrlMatch = output.match(/https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/);

  if (prUrlMatch) {
    return {
      success: true,
      prUrl: prUrlMatch[0],
      summary: 'Implementation completed (result parsed from output)',
    };
  }

  // Check for common error patterns
  if (output.includes('error') || output.includes('failed') || output.includes('Error')) {
    return {
      success: false,
      error: 'Claude Code encountered errors during execution',
      summary: output.slice(-1000), // Last 1000 chars for context
    };
  }

  return {
    success: false,
    error: 'Could not parse Claude output - no result JSON or PR URL found',
    summary: output.slice(-500),
  };
}
