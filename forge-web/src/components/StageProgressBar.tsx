import { CheckCircle2, Loader2, Circle, XCircle } from 'lucide-react';
import type { PipelineStage, StageName } from '../types';
import { STAGE_ORDER, STAGE_LABELS } from '../types';

interface StageProgressBarProps {
  stages: PipelineStage[];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function StageIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return (
        <div className="p-1 bg-emerald-500/10 rounded-full">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
        </div>
      );
    case 'running':
      return (
        <div className="relative p-1">
          <div className="absolute inset-0 rounded-full bg-indigo-400/20 animate-ping" />
          <div className="relative p-1 bg-indigo-500/10 rounded-full">
            <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
          </div>
        </div>
      );
    case 'failed':
      return (
        <div className="p-1 bg-red-500/10 rounded-full">
          <XCircle className="w-5 h-5 text-red-400" />
        </div>
      );
    default:
      return (
        <div className="p-1">
          <Circle className="w-5 h-5 text-forge-muted/30" />
        </div>
      );
  }
}

function getStageData(stages: PipelineStage[], name: StageName): PipelineStage {
  return stages.find((s) => s.name === name) ?? { name, status: 'pending' };
}

function connectorColor(leftStatus: string, rightStatus: string): string {
  if (leftStatus === 'completed' && rightStatus !== 'pending') {
    return 'bg-gradient-to-r from-emerald-400 to-indigo-400';
  }
  if (leftStatus === 'completed') {
    return 'bg-emerald-400/40';
  }
  if (leftStatus === 'failed') {
    return 'bg-red-400/30';
  }
  return 'bg-forge-border';
}

export default function StageProgressBar({ stages }: StageProgressBarProps) {
  return (
    <div className="card-accent p-6">
      <div className="flex items-center justify-between">
        {STAGE_ORDER.map((name, idx) => {
          const stage = getStageData(stages, name);
          const nextStage =
            idx < STAGE_ORDER.length - 1
              ? getStageData(stages, STAGE_ORDER[idx + 1])
              : null;

          return (
            <div key={name} className="flex items-center flex-1 last:flex-none">
              {/* Stage node */}
              <div className="flex flex-col items-center min-w-[80px]">
                <StageIcon status={stage.status} />
                <span
                  className={`text-xs font-medium mt-2 transition-colors ${
                    stage.status === 'running'
                      ? 'text-indigo-400'
                      : stage.status === 'completed'
                        ? 'text-emerald-400'
                        : stage.status === 'failed'
                          ? 'text-red-400'
                          : 'text-forge-muted/50'
                  }`}
                >
                  {STAGE_LABELS[name]}
                </span>
                {stage.duration_ms != null && (
                  <span className="text-[10px] text-forge-muted/40 mt-0.5">
                    {formatDuration(stage.duration_ms)}
                  </span>
                )}
              </div>

              {/* Connector line */}
              {nextStage && (
                <div
                  className={`flex-1 h-[2px] mx-2 rounded-full transition-all duration-700 ${connectorColor(stage.status, nextStage.status)}`}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
