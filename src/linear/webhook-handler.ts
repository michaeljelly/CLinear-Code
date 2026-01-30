import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { linearWebhookPayloadSchema, type LinearWebhookPayload, type LinearComment } from './types.js';
import { linearClient } from './api-client.js';
import { getComputeProvider } from '../compute/index.js';

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
  const requestId = `webhook-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    logger.info(`[${requestId}] ========== WEBHOOK RECEIVED ==========`);
    logger.info(`[${requestId}] Headers: ${JSON.stringify({
      'content-type': req.headers['content-type'],
      'linear-signature': req.headers['linear-signature'] ? '[PRESENT]' : '[MISSING]',
      'linear-delivery': req.headers['linear-delivery'],
      'user-agent': req.headers['user-agent'],
    })}`);
    logger.debug(`[${requestId}] Raw body: ${JSON.stringify(req.body)}`);

    // Parse and validate webhook payload
    const parseResult = linearWebhookPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      logger.error(`[${requestId}] Invalid webhook payload`, {
        errors: parseResult.error.format(),
        rawBody: req.body,
      });
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    const payload = parseResult.data;
    logger.info(`[${requestId}] Parsed webhook: type=${payload.type} action=${payload.action}`);
    logger.debug(`[${requestId}] Payload data: ${JSON.stringify(payload.data)}`);

    // We only care about new comments that mention @Claude
    if (payload.type !== 'Comment' || payload.action !== 'create') {
      logger.info(`[${requestId}] Ignoring ${payload.type} ${payload.action} event (not a comment creation)`);
      res.status(200).json({ status: 'ignored', reason: 'Not a comment creation' });
      return;
    }

    const comment = payload.data as LinearComment;
    logger.info(`[${requestId}] Comment received: id=${comment.id}, body="${comment.body.substring(0, 100)}..."`);

    // Check if the comment mentions @Claude
    if (!mentionsClaude(comment.body)) {
      logger.info(`[${requestId}] Comment does not mention @Claude, ignoring`);
      res.status(200).json({ status: 'ignored', reason: 'No @Claude mention' });
      return;
    }

    logger.info(`[${requestId}] *** Found @Claude mention in comment ${comment.id} ***`);

    // Get the issue ID from the comment
    const issueId = comment.issueId || comment.issue?.id;
    if (!issueId) {
      logger.error(`[${requestId}] Comment has no associated issue`, { comment });
      res.status(400).json({ error: 'No issue ID found' });
      return;
    }

    logger.info(`[${requestId}] Associated issue ID: ${issueId}`);

    // Respond immediately to avoid webhook timeout
    logger.info(`[${requestId}] Sending 202 Accepted response, will process async`);
    res.status(202).json({
      status: 'accepted',
      message: 'Processing @Claude request',
      commentId: comment.id,
      issueId,
      requestId,
    });

    // Process the request asynchronously
    logger.info(`[${requestId}] Starting async processing of Claude request`);
    processClaudeRequest(issueId, comment.id, requestId).catch((error) => {
      logger.error(`[${requestId}] Failed to process Claude request (unhandled)`, {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
      });
    });

  } catch (error) {
    logger.error(`[${requestId}] Webhook handler error (outer catch)`, {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
}

/**
 * Process a @Claude request asynchronously
 */
async function processClaudeRequest(issueId: string, commentId: string, requestId: string): Promise<void> {
  logger.info(`[${requestId}] ========== PROCESSING CLAUDE REQUEST ==========`);
  logger.info(`[${requestId}] Issue ID: ${issueId}, Comment ID: ${commentId}`);

  try {
    // Post acknowledgment comment
    logger.info(`[${requestId}] Posting acknowledgment comment to Linear...`);
    try {
      await linearClient.addComment(
        issueId,
        `🤖 **Claude is on it!**\n\nI'm analyzing this issue and will implement the requested changes. I'll update this thread with a PR link once complete.\n\n_Request ID: ${requestId}_`
      );
      logger.info(`[${requestId}] Acknowledgment comment posted successfully`);
    } catch (ackError) {
      logger.error(`[${requestId}] Failed to post acknowledgment comment`, {
        error: ackError instanceof Error ? ackError.message : ackError,
        stack: ackError instanceof Error ? ackError.stack : undefined,
      });
      // Continue anyway - the main task might still work
    }

    // Fetch full issue context
    logger.info(`[${requestId}] Fetching issue context from Linear...`);
    let context;
    try {
      context = await linearClient.getIssueContext(issueId, commentId);
      logger.info(`[${requestId}] Issue context fetched successfully`, {
        issueIdentifier: context.issue.identifier,
        issueTitle: context.issue.title,
        hasRepository: !!context.repository,
        repositoryUrl: context.repository?.url,
        instructionLength: context.triggerComment.instruction.length,
      });
    } catch (contextError) {
      logger.error(`[${requestId}] Failed to fetch issue context`, {
        error: contextError instanceof Error ? contextError.message : contextError,
        stack: contextError instanceof Error ? contextError.stack : undefined,
      });
      throw contextError;
    }

    if (context.repository) {
      logger.info(`[${requestId}] Repository: ${context.repository.url} (${context.repository.owner}/${context.repository.name})`);
    } else {
      logger.warn(`[${requestId}] No repository configured, running in standalone mode`);
    }
    logger.info(`[${requestId}] Instruction: "${context.triggerComment.instruction.substring(0, 200)}..."`);

    // Execute Claude Code via compute provider
    const provider = getComputeProvider();
    logger.info(`[${requestId}] Using compute provider: ${provider.name}`);
    logger.info(`[${requestId}] Starting Claude Code execution...`);

    const startTime = Date.now();
    let result;
    try {
      result = await provider.executeTask(context);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[${requestId}] Claude Code execution completed in ${duration}s`, {
        success: result.success,
        hasPrUrl: !!result.prUrl,
        hasError: !!result.error,
        outputLength: result.output?.length || 0,
      });
    } catch (execError) {
      logger.error(`[${requestId}] Claude Code execution threw an exception`, {
        error: execError instanceof Error ? execError.message : execError,
        stack: execError instanceof Error ? execError.stack : undefined,
        duration: ((Date.now() - startTime) / 1000).toFixed(1) + 's',
      });
      throw execError;
    }

    // Post result comment with Claude's full output
    logger.info(`[${requestId}] Posting result comment to Linear...`);

    let comment = '';

    if (result.prUrl) {
      comment += `**Pull Request:** ${result.prUrl}\n\n`;
    }

    if (result.output) {
      comment += result.output;
    } else if (result.error) {
      comment += `❌ **Error:** ${result.error}`;
    }

    // Truncate if too long for Linear (limit ~10k chars to be safe)
    if (comment.length > 10000) {
      comment = comment.substring(0, 9900) + '\n\n...(truncated)';
    }

    comment += `\n\n_Request ID: ${requestId}_`;

    try {
      await linearClient.addComment(issueId, comment);
      logger.info(`[${requestId}] Result comment posted`);
    } catch (commentError) {
      logger.error(`[${requestId}] Failed to post result comment`, {
        error: commentError instanceof Error ? commentError.message : commentError,
      });
    }

    logger.info(`[${requestId}] ========== REQUEST COMPLETE ==========`);

  } catch (error) {
    logger.error(`[${requestId}] ========== UNEXPECTED ERROR ==========`, {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    });

    try {
      await linearClient.addComment(
        issueId,
        `❌ **Unexpected Error**\n\nAn error occurred while processing this request:\n\`\`\`\n${error instanceof Error ? error.message : 'Unknown error'}\n\`\`\`\n\nPlease check the server logs for more details.\n\n_Request ID: ${requestId}_`
      );
      logger.info(`[${requestId}] Error comment posted to Linear`);
    } catch (commentError) {
      logger.error(`[${requestId}] Failed to post error comment`, {
        error: commentError instanceof Error ? commentError.message : commentError,
      });
    }
  }
}
