import type { IssueContext } from '../linear/types.js';
import type { ClaudeTaskResult } from '../claude/executor.js';

/**
 * Interface for compute providers that can execute Claude Code tasks
 */
export interface ComputeProvider {
  name: string;

  /**
   * Execute a Claude Code task in this compute environment
   */
  executeTask(context: IssueContext): Promise<ClaudeTaskResult>;

  /**
   * Optional cleanup method for the provider
   */
  cleanup?(): Promise<void>;
}
