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
function buildPrompt(context: IssueContext): string {
  const { issue, comments, triggerComment, repository } = context;

  let prompt = `You are implementing a task from a Linear issue. Here is the full context:

## Issue: ${issue.identifier} - ${issue.title}

**URL:** ${issue.url}
**State:** ${issue.state || 'Unknown'}
**Priority:** ${issue.priority || 'None'}
**Labels:** ${issue.labels.join(', ') || 'None'}

### Description:
${issue.description || 'No description provided.'}

### Comments History:
`;

  comments.forEach((comment, index) => {
    const marker = comment.isTrigger ? ' [TRIGGER - This is the request to implement]' : '';
    prompt += `
**Comment ${index + 1}** by ${comment.author} (${comment.createdAt})${marker}:
${comment.body}
`;
  });

  prompt += `

## Your Task

The user has requested implementation via this comment:

> ${triggerComment.body}

**Extracted instruction:** ${triggerComment.instruction}

## Repository

You will be working in: ${repository?.url}

## Instructions

1. **Understand the request**: Carefully read the issue description and all comments to understand what needs to be implemented.

2. **Create a new branch**: Create a branch named \`${issue.branchName || `${issue.teamKey?.toLowerCase() || 'feature'}/${issue.identifier.toLowerCase()}`}\` (or a similar descriptive name).

3. **Implement the changes**: Make all necessary code changes to fulfill the request.

4. **Test your changes**: If tests exist, run them to ensure nothing is broken.

5. **Create a Pull Request**: Push your branch and create a PR with:
   - A clear title referencing the Linear issue (e.g., "[${issue.identifier}] ${issue.title}")
   - A description that explains what was changed and why
   - Link to the Linear issue

6. **Document your work**: At the end, output a JSON block with the following structure:

\`\`\`json
{
  "success": true,
  "branch": "the-branch-name",
  "prUrl": "https://github.com/owner/repo/pull/123",
  "summary": "Brief description of what was implemented",
  "assumptions": ["Any assumptions you made"],
  "questions": ["Any questions or clarifications needed"]
}
\`\`\`

If you encounter errors or cannot complete the task, output:

\`\`\`json
{
  "success": false,
  "error": "Description of what went wrong",
  "summary": "What was attempted before failure"
}
\`\`\`

## Important Notes

- Make minimal, focused changes - don't refactor unrelated code
- Follow existing code style and patterns
- If something is unclear, make a reasonable assumption and document it
- If you truly cannot proceed, explain why clearly

Begin implementation now.
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

    const proc = spawn('claude', args, {
      cwd: workDir,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
        // Disable interactive features
        CI: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
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
function parseClaudeOutput(output: string): ClaudeTaskResult {
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
