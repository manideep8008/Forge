import { useEffect, useState, useCallback } from 'react';
import type { Pipeline, PipelineEvent, PipelineStage, StageName } from '../types';
import { useWebSocket } from './useWebSocket';
import { STAGE_ORDER } from '../types';

interface UsePipelineReturn {
  pipeline: Pipeline | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  events: PipelineEvent[];
  lastEvent: PipelineEvent | null;
  refetch: () => void;
}

export function usePipeline(pipelineId: string | undefined): UsePipelineReturn {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { connected, events, lastEvent } = useWebSocket(pipelineId);

  const fetchPipeline = useCallback(async () => {
    if (!pipelineId) return;

    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/pipeline/${pipelineId}`);
      if (!res.ok) throw new Error(`Failed to fetch pipeline: ${res.statusText}`);
      const raw = await res.json();
      // Normalize API response to match Pipeline type
      const defaultStages: PipelineStage[] = STAGE_ORDER.map((name: StageName) => ({
        name,
        status: 'pending' as const,
      }));
      const data: Pipeline = {
        id: raw.id || raw.pipeline_id || pipelineId,
        name: raw.name || raw.description || `Pipeline ${(raw.pipeline_id || pipelineId).slice(0, 8)}`,
        description: raw.description || raw.input_text || '',
        status: raw.status || 'pending',
        current_stage: raw.current_stage,
        stages: raw.stages?.length ? raw.stages : defaultStages,
        agents: raw.agents || [],
        created_at: raw.created_at || new Date().toISOString(),
        updated_at: raw.updated_at || new Date().toISOString(),
      };
      setPipeline(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [pipelineId]);

  useEffect(() => {
    fetchPipeline();
    // Poll every 3s while pipeline is active (not completed/failed)
    const interval = setInterval(() => {
      fetchPipeline();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchPipeline]);

  // Apply real-time WebSocket updates to pipeline state
  useEffect(() => {
    if (!lastEvent || !pipeline) return;

    setPipeline((prev) => {
      if (!prev) return prev;

      const updated = { ...prev, updated_at: lastEvent.timestamp };

      switch (lastEvent.type) {
        case 'stage_started': {
          updated.current_stage = lastEvent.stage;
          updated.stages = prev.stages.map((s) =>
            s.name === lastEvent.stage
              ? { ...s, status: 'running' as const, started_at: lastEvent.timestamp }
              : s,
          );
          break;
        }
        case 'stage_completed': {
          updated.stages = prev.stages.map((s) =>
            s.name === lastEvent.stage
              ? {
                  ...s,
                  status: 'completed' as const,
                  completed_at: lastEvent.timestamp,
                  duration_ms: lastEvent.data?.duration_ms as number | undefined,
                }
              : s,
          );
          break;
        }
        case 'stage_failed': {
          updated.stages = prev.stages.map((s) =>
            s.name === lastEvent.stage
              ? {
                  ...s,
                  status: 'failed' as const,
                  error: lastEvent.data?.error as string | undefined,
                }
              : s,
          );
          break;
        }
        case 'agent_output':
        case 'agent_streaming': {
          const agentData = lastEvent.data as Record<string, unknown> | undefined;
          if (agentData) {
            const existingIdx = prev.agents.findIndex(
              (a) => a.agent === lastEvent.agent && a.stage === lastEvent.stage,
            );
            if (existingIdx >= 0) {
              updated.agents = [...prev.agents];
              updated.agents[existingIdx] = {
                ...updated.agents[existingIdx],
                ...agentData,
              };
            } else {
              updated.agents = [
                ...prev.agents,
                {
                  agent: lastEvent.agent ?? 'unknown',
                  stage: lastEvent.stage ?? 'requirements',
                  status: 'running',
                  ...agentData,
                },
              ];
            }
          }
          break;
        }
        case 'pipeline_completed': {
          updated.status = 'completed';
          break;
        }
        case 'pipeline_failed': {
          updated.status = 'failed';
          break;
        }
        case 'hitl_required': {
          updated.current_stage = 'hitl';
          break;
        }
      }

      return updated;
    });
  }, [lastEvent, pipeline]);

  return {
    pipeline,
    loading,
    error,
    connected,
    events,
    lastEvent,
    refetch: fetchPipeline,
  };
}
