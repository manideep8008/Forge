export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'awaiting_approval';

export type StageName =
  | 'requirements'
  | 'architect'
  | 'codegen'
  | 'review'
  | 'test'
  | 'hitl'
  | 'deploy';

export const STAGE_ORDER: StageName[] = [
  'requirements',
  'architect',
  'codegen',
  'review',
  'test',
  'hitl',
  'deploy',
];

export const STAGE_LABELS: Record<StageName, string> = {
  requirements: 'Requirements',
  architect: 'Architect',
  codegen: 'Codegen',
  review: 'Review',
  test: 'Test',
  hitl: 'HITL',
  deploy: 'Deploy',
};

export const STAGE_DESCRIPTIONS: Record<StageName, { working: string; icon: string }> = {
  requirements: { working: 'Analyzing requirements from your prompt…', icon: '📋' },
  architect: { working: 'Designing system architecture and file plan…', icon: '🏗️' },
  codegen: { working: 'Generating source code files…', icon: '⚡' },
  review: { working: 'Reviewing code for quality and issues…', icon: '🔍' },
  test: { working: 'Running automated tests…', icon: '🧪' },
  hitl: { working: 'Awaiting your review and approval…', icon: '👤' },
  deploy: { working: 'Building and deploying application…', icon: '🚀' },
};

export interface PipelineStage {
  name: StageName;
  status: StageStatus;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  error?: string;
}

export interface ReviewIssue {
  severity: 'error' | 'warning' | 'info';
  file: string;
  line?: number;
  message: string;
  rule?: string;
}

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration_ms: number;
  error?: string;
}

export interface AgentOutput {
  agent: string;
  stage: StageName;
  status: StageStatus;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  tokens_used?: number;
  output?: Record<string, unknown>;
  streaming_content?: string;
  diff?: {
    filename: string;
    old_code: string;
    new_code: string;
  }[];
  review_issues?: ReviewIssue[];
  test_results?: TestResult[];
  test_coverage?: number;
}

export interface Pipeline {
  id: string;
  name?: string;
  description?: string;
  input_text?: string;
  intent_type?: string;
  status: StageStatus;
  current_stage?: StageName;
  stages: PipelineStage[];
  agents: AgentOutput[];
  created_at: string;
  updated_at: string;
}

export type PipelineEventType =
  | 'stage_started'
  | 'stage_completed'
  | 'stage_failed'
  | 'agent_output'
  | 'agent_streaming'
  | 'pipeline_completed'
  | 'pipeline_failed'
  | 'pipeline_started'
  | 'pipeline_halted'
  | 'pipeline.intent_classified'
  | 'pipeline.started'
  | 'pipeline.completed'
  | 'pipeline.halted'
  | 'pipeline.cancelled'
  | 'agent.requirements.completed'
  | 'agent.architect.completed'
  | 'agent.codegen.completed'
  | 'agent.review.completed'
  | 'agent.test.completed'
  | 'agent.cicd.completed'
  | 'hitl_required';

export interface PipelineEvent {
  type: PipelineEventType;
  pipeline_id: string;
  stage?: StageName;
  agent?: string;
  data?: Record<string, unknown> & { message?: string };
  timestamp: string;
}

export interface HITLDecision {
  action: 'approve' | 'reject' | 'request_changes';
  comment?: string;
}
