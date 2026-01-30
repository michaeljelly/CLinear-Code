import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { linearWebhookPayloadSchema, type LinearWebhookPayload, type LinearComment } from './types.js';
import { linearClient } from './api-client.js';
import { executeClaudeTask } from '../claude/executor.js';

/**
 * Verify Linear webhook signature
 */
export function verifyWebhookSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Skip verification if no secret configured (development mode)
  if (!config.LINEAR_WEBHOOK_SECRET) {
    logger.warn('LINEAR_WEBHOOK_SECRET not set - skipping signature verification');
    next();
    return;
  }

  const signature = req.headers['linear-signature'] as string;
  if (!signature) {
    logger.error('Missing Linear-Signature header');
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  const body = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', config.LINEAR_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    logger.error('Invalid webhook signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}

/**
 * Check if a comment mentions @Claude
 */
function mentionsClaude(body: string): boolean {
  return /@claude/i.test(body);
}

/**
 * Handle incoming Linear webhook
 */
export async function handleLinearWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    // Parse and validate webhook payload
    const parseResult = linearWebhookPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      logger.error('Invalid webhook payload', { errors: parseResult.error.format() });
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    const payload = parseResult.data;
    logger.info(`Received webhook: ${payload.type} ${payload.action}`);

    // We only care about new comments that mention @Claude
    if (payload.type !== 'Comment' || payload.action !== 'create') {
      logger.debug(`Ignoring ${payload.type} ${payload.action} event`);
      res.status(200).json({ status: 'ignored', reason: 'Not a comment creation' });
      return;
    }

    const comment = payload.data as LinearComment;

    // Check if the comment mentions @Claude
    if (!mentionsClaude(comment.body)) {
      logger.debug('Comment does not mention @Claude');
      res.status(200).json({ status: 'ignored', reason: 'No @Claude mention' });
      return;
    }

    logger.info(`Found @Claude mention in comment ${comment.id}`);

    // Get the issue ID from the comment
    const issueId = comment.issueId || comment.issue?.id;
    if (!issueId) {
      logger.error('Comment has no associated issue');
      res.status(400).json({ error: 'No issue ID found' });
      return;
    }

    // Respond immediately to avoid webhook timeout
    res.status(202).json({
      status: 'accepted',
      message: 'Processing @Claude request',
      commentId: comment.id,
      issueId,
    });

    // Process the request asynchronously
    processClaudeRequest(issueId, comment.id).catch((error) => {
      logger.error('Failed to process Claude request', { error: error.message });
    });

  } catch (error) {
    logger.error('Webhook handler error', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Process a @Claude request asynchronously
 */
async function processClaudeRequest(issueId: string, commentId: string): Promise<void> {
  logger.info(`Processing Claude request for issue ${issueId}`);

  try {
    // Post acknowledgment comment
    await linearClient.addComment(
      issueId,
      `🤖 **Claude is on it!**\n\nI'm analyzing this issue and will implement the requested changes. I'll update this thread with a PR link once complete.`
    );

    // Fetch full issue context
    const context = await linearClient.getIssueContext(issueId, commentId);

    if (!context.repository) {
      await linearClient.addComment(
        issueId,
        `❌ **Could not determine repository**\n\nPlease add a GitHub repository URL to the issue description, or add a label in the format \`repo:owner/name\`, or configure a default repository.`
      );
      return;
    }

    logger.info(`Repository: ${context.repository.url}`);
    logger.info(`Instruction: ${context.triggerComment.instruction}`);

    // Execute Claude Code
    const result = await executeClaudeTask(context);

    // Post result comment
    if (result.success && result.prUrl) {
      let comment = `✅ **Implementation Complete!**\n\n`;
      comment += `**Pull Request:** ${result.prUrl}\n\n`;

      if (result.summary) {
        comment += `**Summary:**\n${result.summary}\n\n`;
      }

      if (result.assumptions && result.assumptions.length > 0) {
        comment += `**Assumptions made:**\n`;
        result.assumptions.forEach(a => {
          comment += `- ${a}\n`;
        });
        comment += '\n';
      }

      if (result.questions && result.questions.length > 0) {
        comment += `**Questions/Clarifications needed:**\n`;
        result.questions.forEach(q => {
          comment += `- ${q}\n`;
        });
      }

      await linearClient.addComment(issueId, comment);
    } else {
      let comment = `❌ **Implementation Failed**\n\n`;

      if (result.error) {
        comment += `**Error:** ${result.error}\n\n`;
      }

      if (result.summary) {
        comment += `**What was attempted:**\n${result.summary}\n\n`;
      }

      comment += `Please review the issue description and try again, or implement manually.`;

      await linearClient.addComment(issueId, comment);
    }

  } catch (error) {
    logger.error('Error processing Claude request', { error });

    try {
      await linearClient.addComment(
        issueId,
        `❌ **Unexpected Error**\n\nAn error occurred while processing this request:\n\`\`\`\n${error instanceof Error ? error.message : 'Unknown error'}\n\`\`\`\n\nPlease check the server logs for more details.`
      );
    } catch (commentError) {
      logger.error('Failed to post error comment', { error: commentError });
    }
  }
}
