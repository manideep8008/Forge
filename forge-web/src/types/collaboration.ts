// ── Workspaces ────────────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  role: 'owner' | 'member';
  created_at: string;
}

export interface WorkspaceMember {
  id: string;
  email: string;
  role: 'owner' | 'member';
  joined_at: string;
}

export interface WorkspaceDetail extends Workspace {
  owner_id: string;
  members: WorkspaceMember[];
}

// ── Comments ──────────────────────────────────────────────────────────────────

export interface PipelineComment {
  id: string;
  stage_name?: string;
  body: string;
  author_email: string;
  created_at: string;
}

// ── Templates ─────────────────────────────────────────────────────────────────

export interface PipelineTemplate {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  is_public: boolean;
  workspace_id?: string;
  user_id: string;
  created_at: string;
}

// ── Schedules ─────────────────────────────────────────────────────────────────

export interface ScheduledPipeline {
  id: string;
  cron_expr: string;
  next_run_at: string;
  enabled: boolean;
  template_name: string;
  template_prompt: string;
  created_at: string;
}
