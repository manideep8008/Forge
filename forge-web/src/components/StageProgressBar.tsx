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
      return <CheckCircle2 className="w-6 h-6 text-emerald-400" />;
    case 'running':
      return (
        <div className="relative">
          <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          <div className="absolute inset-0 rounded-full animate-pulse-blue bg-blue-400/20" />
        </div>
      );
    case 'failed':
      return <XCircle className="w-6 h-6 text-red-400" />;
    default:
      return <Circle className="w-6 h-6 text-slate-600" />;
  }
}

function getStageData(stages: PipelineStage[], name: StageName): PipelineStage {
  return stages.find((s) => s.name === name) ?? { name, status: 'pending' };
}

function connectorColor(leftStatus: string, rightStatus: string): string {
  if (leftStatus === 'completed' && rightStatus !== 'pending') {
    return 'bg-emerald-400';
  }
  if (leftStatus === 'completed') {
    return 'bg-slate-600';
  }
  if (leftStatus === 'failed') {
    return 'bg-red-400/50';
  }
  return 'bg-slate-700';
}

export default function StageProgressBar({ stages }: StageProgressBarProps) {
  return (
    <div className="card p-6">
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
                  className={`text-xs font-medium mt-2 ${
                    stage.status === 'running'
                      ? 'text-blue-400'
                      : stage.status === 'completed'
                        ? 'text-emerald-400'
                        : stage.status === 'failed'
                          ? 'text-red-400'
                          : 'text-slate-500'
                  }`}
                >
                  {STAGE_LABELS[name]}
                </span>
                {stage.duration_ms != null && (
                  <span className="text-[10px] text-slate-500 mt-0.5">
                    {formatDuration(stage.duration_ms)}
                  </span>
                )}
              </div>

              {/* Connector line */}
              {nextStage && (
                <div
                  className={`flex-1 h-0.5 mx-1 rounded-full transition-colors duration-500 ${connectorColor(stage.status, nextStage.status)}`}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
