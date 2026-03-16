-- Forge Database Schema
-- Version: 1.0

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Pipeline lifecycle tracking
CREATE TABLE pipelines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(255) NOT NULL,
    input_text TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    intent_type VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_pipelines_user ON pipelines(user_id);
CREATE INDEX idx_pipelines_status ON pipelines(status);
CREATE INDEX idx_pipelines_created ON pipelines(created_at DESC);

-- Per-stage execution records
CREATE TABLE pipeline_stages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    stage_name VARCHAR(100) NOT NULL,
    agent_name VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    tokens_used INTEGER DEFAULT 0,
    iteration INTEGER DEFAULT 1,
    error_message TEXT
);

CREATE INDEX idx_stages_pipeline ON pipeline_stages(pipeline_id);

-- Raw agent outputs for replay/debugging
CREATE TABLE agent_outputs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stage_id UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
    output_type VARCHAR(100) NOT NULL,
    output_data JSONB NOT NULL,
    model_used VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outputs_stage ON agent_outputs(stage_id);

-- File-level change tracking
CREATE TABLE files_changed (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    filepath VARCHAR(500) NOT NULL,
    change_type VARCHAR(20) NOT NULL CHECK (change_type IN ('add', 'modify', 'delete')),
    diff_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_files_pipeline ON files_changed(pipeline_id);

-- Individual test outcomes
CREATE TABLE test_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stage_id UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
    test_name VARCHAR(500) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('passed', 'failed', 'skipped', 'error')),
    duration_ms INTEGER,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tests_stage ON test_results(stage_id);

-- Immutable audit trail
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL,
    action VARCHAR(200) NOT NULL,
    actor VARCHAR(100) NOT NULL,
    details JSONB DEFAULT '{}',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_pipeline ON audit_log(pipeline_id);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
