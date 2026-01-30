import { z } from 'zod';

// Linear webhook payload schemas
export const linearUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
});

export const linearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().optional(),
  url: z.string(),
  branchName: z.string().optional(),
  priority: z.number().optional(),
  state: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
  }).optional(),
  team: z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
  }).optional(),
  labels: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })).optional(),
  assignee: linearUserSchema.optional(),
  creator: linearUserSchema.optional(),
});

export const linearCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  issueId: z.string().optional(),
  issue: linearIssueSchema.optional(),
  user: linearUserSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

export const linearWebhookPayloadSchema = z.object({
  action: z.enum(['create', 'update', 'remove']),
  type: z.enum(['Issue', 'Comment', 'IssueLabel', 'Project', 'Cycle', 'Reaction']),
  data: z.union([linearIssueSchema, linearCommentSchema]),
  url: z.string().optional(),
  createdAt: z.string(),
  organizationId: z.string().optional(),
  webhookId: z.string().optional(),
  webhookTimestamp: z.number().optional(),
});

export type LinearUser = z.infer<typeof linearUserSchema>;
export type LinearIssue = z.infer<typeof linearIssueSchema>;
export type LinearComment = z.infer<typeof linearCommentSchema>;
export type LinearWebhookPayload = z.infer<typeof linearWebhookPayloadSchema>;

// Extracted issue context for Claude
export interface IssueContext {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    url: string;
    branchName?: string;
    priority?: number;
    state?: string;
    teamKey?: string;
    labels: string[];
  };
  comments: Array<{
    id: string;
    body: string;
    author: string;
    createdAt: string;
    isTrigger: boolean;
  }>;
  triggerComment: {
    id: string;
    body: string;
    author: string;
    instruction: string;
  };
  repository?: {
    url: string;
    owner: string;
    name: string;
  };
}
