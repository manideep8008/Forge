export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

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
  | 'hitl_required';

export interface PipelineEvent {
  type: PipelineEventType;
  pipeline_id: string;
  stage?: StageName;
  agent?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export interface HITLDecision {
  action: 'approve' | 'reject' | 'request_changes';
  comment?: string;
}
