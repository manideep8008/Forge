-- Collaboration + Pipeline Intelligence schema
-- Version: 1.2

-- ── Workspaces ────────────────────────────────────────────────────────────────
CREATE TABLE workspaces (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(255) NOT NULL,
    owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workspaces_owner ON workspaces(owner_id);

CREATE TABLE workspace_members (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         VARCHAR(20) NOT NULL DEFAULT 'member'
                     CHECK (role IN ('owner', 'member')),
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

-- ── Pipeline Comments ─────────────────────────────────────────────────────────
CREATE TABLE pipeline_comments (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    stage_name  VARCHAR(100),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        VARCHAR(2000) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pipeline_comments_pipeline ON pipeline_comments(pipeline_id);

-- ── Pipeline Templates ────────────────────────────────────────────────────────
CREATE TABLE pipeline_templates (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         VARCHAR(255) NOT NULL,
    description  TEXT,
    prompt       TEXT NOT NULL,
    is_public    BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_templates_workspace ON pipeline_templates(workspace_id);
CREATE INDEX idx_templates_user      ON pipeline_templates(user_id);
CREATE INDEX idx_templates_public    ON pipeline_templates(is_public) WHERE is_public = true;

-- ── Scheduled Pipelines ───────────────────────────────────────────────────────
CREATE TABLE scheduled_pipelines (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id  UUID NOT NULL REFERENCES pipeline_templates(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cron_expr    VARCHAR(100) NOT NULL,
    next_run_at  TIMESTAMPTZ NOT NULL,
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_schedules_next_run ON scheduled_pipelines(next_run_at)
    WHERE enabled = true;

-- ── Extend pipelines table ────────────────────────────────────────────────────
-- Idempotent: drop the old misnamed column if it exists, then add the correct one
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pipelines' AND column_name = 'chain_parent') THEN
        ALTER TABLE pipelines DROP COLUMN chain_parent;
    END IF;
END $$;

ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS workspace_id         UUID REFERENCES workspaces(id)        ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS template_id          UUID REFERENCES pipeline_templates(id)  ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS parent_pipeline_id   UUID REFERENCES pipelines(id)          ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pipelines_workspace ON pipelines(workspace_id);
