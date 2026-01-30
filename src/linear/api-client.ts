import { LinearClient, Issue, Comment } from '@linear/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { IssueContext } from './types.js';

export class LinearApiClient {
  private client: LinearClient;

  constructor() {
    this.client = new LinearClient({
      apiKey: config.LINEAR_API_KEY,
    });
  }

  /**
   * Fetch the full context of an issue including all comments
   */
  async getIssueContext(issueId: string, triggerCommentId: string): Promise<IssueContext> {
    logger.info(`Fetching issue context for ${issueId}`);

    // Fetch the issue with all related data
    const issue = await this.client.issue(issueId);
    const state = await issue.state;
    const team = await issue.team;
    const labelsConnection = await issue.labels();
    const labels = labelsConnection.nodes.map(l => l.name);

    // Fetch all comments
    const commentsConnection = await issue.comments();
    const comments = await Promise.all(
      commentsConnection.nodes.map(async (comment) => {
        const user = await comment.user;
        return {
          id: comment.id,
          body: comment.body,
          author: user?.name || 'Unknown',
          createdAt: comment.createdAt.toISOString(),
          isTrigger: comment.id === triggerCommentId,
        };
      })
    );

    // Sort comments by creation date
    comments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Find the trigger comment and extract the instruction
    const triggerComment = comments.find(c => c.isTrigger);
    if (!triggerComment) {
      throw new Error(`Trigger comment ${triggerCommentId} not found`);
    }

    // Extract instruction from @Claude mention
    const instruction = this.extractInstruction(triggerComment.body);

    // Try to extract repository info from issue description or labels
    const repository = this.extractRepositoryInfo(issue.description || '', labels);

    return {
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description || '',
        url: issue.url,
        branchName: issue.branchName,
        priority: issue.priority,
        state: state?.name,
        teamKey: team?.key,
        labels,
      },
      comments,
      triggerComment: {
        id: triggerComment.id,
        body: triggerComment.body,
        author: triggerComment.author,
        instruction,
      },
      repository,
    };
  }

  /**
   * Extract the instruction following @Claude mention
   */
  private extractInstruction(body: string): string {
    // Match @Claude (case insensitive) followed by any text
    const match = body.match(/@claude\s*([\s\S]*)/i);
    if (match) {
      return match[1].trim();
    }
    return body;
  }

  /**
   * Try to extract repository information from issue content
   */
  private extractRepositoryInfo(
    description: string,
    labels: string[]
  ): IssueContext['repository'] | undefined {
    // Check for GitHub URL in description
    const githubUrlMatch = description.match(
      /https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s\)]+)/
    );
    if (githubUrlMatch) {
      return {
        url: `https://github.com/${githubUrlMatch[1]}/${githubUrlMatch[2]}`,
        owner: githubUrlMatch[1],
        name: githubUrlMatch[2].replace(/\.git$/, ''),
      };
    }

    // Check for repo label (format: repo:owner/name)
    const repoLabel = labels.find(l => l.startsWith('repo:'));
    if (repoLabel) {
      const [owner, name] = repoLabel.slice(5).split('/');
      if (owner && name) {
        return {
          url: `https://github.com/${owner}/${name}`,
          owner,
          name,
        };
      }
    }

    // Fall back to default repo if configured
    if (config.GITHUB_DEFAULT_REPO) {
      const [owner, name] = config.GITHUB_DEFAULT_REPO.split('/');
      if (owner && name) {
        return {
          url: `https://github.com/${owner}/${name}`,
          owner,
          name,
        };
      }
    }

    return undefined;
  }

  /**
   * Add a comment to an issue
   */
  async addComment(issueId: string, body: string): Promise<void> {
    logger.info(`Adding comment to issue ${issueId}`);
    await this.client.createComment({
      issueId,
      body,
    });
  }

  /**
   * Update issue state
   */
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    logger.info(`Updating issue ${issueId} state to ${stateId}`);
    await this.client.updateIssue(issueId, {
      stateId,
    });
  }
}

export const linearClient = new LinearApiClient();
