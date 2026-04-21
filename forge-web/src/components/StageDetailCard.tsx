import { useState, useEffect } from 'react';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Coins,
  FileCode2,
  AlertTriangle,
  ShieldCheck,
  FlaskConical,
  Rocket,
  Brain,
  LayoutDashboard,
} from 'lucide-react';
import type { Pipeline, StageName, AgentOutput } from '../types';
import { STAGE_LABELS, STAGE_DESCRIPTIONS } from '../types';

interface StageDetailCardProps {
  pipeline: Pipeline;
}

/** Return the "most interesting" stage to display — either the running one or the latest completed one. */
function getActiveStage(pipeline: Pipeline): { name: StageName; status: string } | null {
  // Running stage has priority
  const running = pipeline.stages.find((s) => s.status === 'running');
  if (running) return running;

  // Fall back to most recently completed
  const completed = [...pipeline.stages].reverse().find((s) => s.status === 'completed' || s.status === 'failed');
  return completed ?? null;
}

function getAgentForStage(pipeline: Pipeline, stageName: string): AgentOutput | undefined {
  return pipeline.agents.find((a) => a.stage === stageName || a.agent === stageName);
}

const STAGE_ICONS: Record<string, React.ReactNode> = {
  requirements: <Brain className="w-5 h-5" />,
  architect: <LayoutDashboard className="w-5 h-5" />,
  codegen: <FileCode2 className="w-5 h-5" />,
  review: <ShieldCheck className="w-5 h-5" />,
  test: <FlaskConical className="w-5 h-5" />,
  hitl: <AlertTriangle className="w-5 h-5" />,
  deploy: <Rocket className="w-5 h-5" />,
};

function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return (
    <span className="tabular-nums text-xs text-forge-muted font-mono">
      {m > 0 ? `${m}m ${s}s` : `${s}s`}
    </span>
  );
}

function ShimmerLine({ width = '75%' }: { width?: string }) {
  return (
    <div
      className="h-2.5 rounded-full bg-gradient-to-r from-forge-border/0 via-forge-border/40 to-forge-border/0 animate-shimmer"
      style={{ width, backgroundSize: '200% 100%' }}
    />
  );
}

export default function StageDetailCard({ pipeline }: StageDetailCardProps) {
  const active = getActiveStage(pipeline);
  if (!active) return null;

  const { name, status } = active;
  const agent = getAgentForStage(pipeline, name);
  const desc = STAGE_DESCRIPTIONS[name];
  const isRunning = status === 'running';
  const isFailed = status === 'failed';
  const stage = pipeline.stages.find((s) => s.name === name);

  const borderClass = isRunning
    ? 'border-indigo-500/30 shadow-[0_0_20px_-5px_rgba(99,102,241,0.15)]'
    : isFailed
      ? 'border-red-500/30'
      : 'border-emerald-500/30';

  const headerBg = isRunning
    ? 'bg-indigo-500/5'
    : isFailed
      ? 'bg-red-500/5'
      : 'bg-emerald-500/5';

  return (
    <div className={`card overflow-hidden transition-all duration-300 ${borderClass}`}>
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 py-3 ${headerBg} border-b border-forge-border/50`}>
        <div className={`p-1.5 rounded-lg ${isRunning ? 'text-indigo-400' : isFailed ? 'text-red-400' : 'text-emerald-400'}`}>
          {isRunning ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : isFailed ? (
            <XCircle className="w-5 h-5" />
          ) : (
            STAGE_ICONS[name] ?? <CheckCircle2 className="w-5 h-5" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className={`text-sm font-bold ${isRunning ? 'text-indigo-300' : isFailed ? 'text-red-300' : 'text-emerald-300'}`}>
              {STAGE_LABELS[name]}
            </h3>
            {isRunning && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
              </span>
            )}
          </div>
          <p className={`text-xs ${isRunning ? 'text-indigo-300/60' : isFailed ? 'text-red-300/60' : 'text-emerald-300/60'}`}>
            {isRunning ? desc.working : isFailed ? `${STAGE_LABELS[name]} encountered an error` : `${STAGE_LABELS[name]} completed successfully`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {stage?.started_at && isRunning && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-white/5 rounded-lg">
              <Clock className="w-3 h-3 text-forge-muted" />
              <ElapsedTimer startedAt={stage.started_at} />
            </div>
          )}
          {agent?.duration_ms != null && !isRunning && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-white/5 rounded-lg">
              <Clock className="w-3 h-3 text-forge-muted" />
              <span className="text-xs text-forge-muted font-mono tabular-nums">
                {agent.duration_ms < 1000 ? `${agent.duration_ms}ms` : `${(agent.duration_ms / 1000).toFixed(1)}s`}
              </span>
            </div>
          )}
          {agent?.tokens_used != null && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-white/5 rounded-lg">
              <Coins className="w-3 h-3 text-forge-muted" />
              <span className="text-xs text-forge-muted font-mono tabular-nums">
                {agent.tokens_used.toLocaleString()}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Body — contextual content per stage */}
      <div className="px-4 py-3 space-y-3">
        {isRunning && !agent?.output && (
          /* Shimmer loading skeleton */
          <div className="space-y-2.5">
            <ShimmerLine width="90%" />
            <ShimmerLine width="70%" />
            <ShimmerLine width="55%" />
          </div>
        )}

        {/* Requirements output */}
        {name === 'requirements' && agent?.output && (
          <RequirementsDetail output={agent.output} />
        )}

        {/* Architect output */}
        {name === 'architect' && agent?.output && (
          <ArchitectDetail output={agent.output} />
        )}

        {/* Codegen output */}
        {name === 'codegen' && agent?.output && (
          <CodegenDetail output={agent.output} />
        )}

        {/* Review output */}
        {name === 'review' && agent?.review_issues && (
          <ReviewDetail issues={agent.review_issues} />
        )}

        {/* Test output */}
        {name === 'test' && agent?.test_results && (
          <TestDetail results={agent.test_results} coverage={agent.test_coverage} />
        )}

        {/* Deploy output */}
        {name === 'deploy' && agent?.output && (
          <DeployDetail output={agent.output} />
        )}

        {/* HITL */}
        {name === 'hitl' && isRunning && (
          <div className="flex items-center gap-2 text-xs text-amber-300/80">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            Pipeline is waiting for your approval. Check the review modal.
          </div>
        )}

        {/* Streaming content */}
        {agent?.streaming_content && (
          <pre className="text-[11px] text-slate-300 bg-forge-bg rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto border border-forge-border font-mono leading-relaxed">
            {agent.streaming_content}
            {isRunning && <span className="inline-block w-1.5 h-3.5 bg-indigo-400 animate-pulse ml-0.5 rounded-sm" />}
          </pre>
        )}

        {/* Error message */}
        {stage?.error && (
          <div className="flex items-start gap-2 text-xs text-red-300/80 bg-red-500/5 border border-red-500/10 rounded-lg p-3">
            <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
            <span>{stage.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}


/* ═════════════ Stage-specific detail sub-components ═════════════ */

function RequirementsDetail({ output }: { output: Record<string, unknown> }) {
  const title = output.title as string | undefined;
  const description = output.description as string | undefined;
  return (
    <div className="space-y-2">
      {title && (
        <div>
          <span className="text-[10px] uppercase tracking-widest text-forge-muted/50">Project</span>
          <p className="text-xs text-forge-text font-medium mt-0.5">{title}</p>
        </div>
      )}
      {description && (
        <p className="text-[11px] text-forge-muted leading-relaxed line-clamp-3">{description}</p>
      )}
    </div>
  );
}

function ArchitectDetail({ output }: { output: Record<string, unknown> }) {
  const decisions = (output.architecture_decisions as string[]) ?? [];
  const filePlan = (output.file_plan as Record<string, unknown>) ?? {};
  const fileNames = Object.keys(filePlan);
  return (
    <div className="space-y-3">
      {decisions.length > 0 && (
        <div>
          <span className="text-[10px] uppercase tracking-widest text-forge-muted/50">
            Decisions ({decisions.length})
          </span>
          <ul className="mt-1 space-y-1">
            {decisions.slice(0, 4).map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-slate-300">
                <span className="text-indigo-400 font-bold shrink-0">{i + 1}.</span>
                <span className="line-clamp-1">{d}</span>
              </li>
            ))}
            {decisions.length > 4 && (
              <li className="text-[10px] text-forge-muted/50 pl-5">+{decisions.length - 4} more</li>
            )}
          </ul>
        </div>
      )}
      {fileNames.length > 0 && (
        <div>
          <span className="text-[10px] uppercase tracking-widest text-forge-muted/50">
            Files ({fileNames.length})
          </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {fileNames.slice(0, 6).map((f) => (
              <span key={f} className="text-[10px] font-mono px-1.5 py-0.5 bg-emerald-400/5 text-emerald-400/80 rounded border border-emerald-400/10">
                {f}
              </span>
            ))}
            {fileNames.length > 6 && (
              <span className="text-[10px] text-forge-muted/50">+{fileNames.length - 6} more</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CodegenDetail({ output }: { output: Record<string, unknown> }) {
  const files = (output.files as Record<string, unknown>) ?? output;
  const fileNames = Object.keys(files).filter((k) => k !== 'branch' && k !== 'files');
  // If the output has a 'files' key, use its keys
  const actualFiles = output.files ? Object.keys(output.files as Record<string, unknown>) : fileNames;

  return (
    <div>
      <span className="text-[10px] uppercase tracking-widest text-forge-muted/50">
        Generated Files ({actualFiles.length})
      </span>
      <div className="flex flex-wrap gap-1 mt-1">
        {actualFiles.slice(0, 8).map((f) => (
          <span key={f} className="text-[10px] font-mono px-1.5 py-0.5 bg-emerald-400/5 text-emerald-400/80 rounded border border-emerald-400/10">
            {f.split('/').pop()}
          </span>
        ))}
        {actualFiles.length > 8 && (
          <span className="text-[10px] text-forge-muted/50">+{actualFiles.length - 8} more</span>
        )}
      </div>
    </div>
  );
}

function ReviewDetail({ issues }: { issues: { severity: string; message: string }[] }) {
  const criticalCount = issues.filter((i) => i.severity === 'critical' || i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;
  const passed = criticalCount === 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {passed ? (
          <span className="badge bg-emerald-400/10 text-emerald-400 border border-emerald-400/20">
            <CheckCircle2 className="w-3 h-3" /> Passed
          </span>
        ) : (
          <span className="badge bg-red-400/10 text-red-400 border border-red-400/20">
            <XCircle className="w-3 h-3" /> Critical Issues
          </span>
        )}
      </div>
      <div className="flex gap-3 text-[11px]">
        {criticalCount > 0 && (
          <span className="text-red-400">
            {criticalCount} critical
          </span>
        )}
        {warningCount > 0 && (
          <span className="text-amber-400">
            {warningCount} warnings
          </span>
        )}
        {infoCount > 0 && (
          <span className="text-indigo-400">
            {infoCount} info
          </span>
        )}
      </div>
      <ul className="space-y-1 max-h-32 overflow-y-auto">
        {issues.slice(0, 5).map((issue, i) => (
          <li
            key={i}
            className={`text-[11px] flex items-start gap-1.5 py-1 px-2 rounded border ${
              issue.severity === 'error' || issue.severity === 'critical'
                ? 'bg-red-500/5 border-red-500/10 text-red-300'
                : issue.severity === 'warning'
                  ? 'bg-amber-500/5 border-amber-500/10 text-amber-300'
                  : 'bg-indigo-500/5 border-indigo-500/10 text-indigo-300'
            }`}
          >
            <span className="truncate">{issue.message}</span>
          </li>
        ))}
        {issues.length > 5 && (
          <li className="text-[10px] text-forge-muted/50 pl-2">+{issues.length - 5} more issues</li>
        )}
      </ul>
    </div>
  );
}

function TestDetail({ results, coverage }: { results: { name: string; status: string; duration_ms: number; error?: string }[]; coverage?: number }) {
  const passedCount = results.filter((r) => r.status === 'passed').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-slate-300">
          <span className="text-emerald-400 font-bold">{passedCount}</span> passed
          {failedCount > 0 && (
            <>, <span className="text-red-400 font-bold">{failedCount}</span> failed</>
          )}
          <span className="text-forge-muted/50"> / {results.length} total</span>
        </span>
        {coverage != null && coverage > 0 && (
          <div className="flex items-center gap-2 flex-1 max-w-[120px]">
            <div className="flex-1 h-1.5 bg-forge-border/30 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-700"
                style={{ width: `${Math.min(100, coverage)}%` }}
              />
            </div>
            <span className="text-[10px] text-forge-muted tabular-nums">{coverage.toFixed(0)}%</span>
          </div>
        )}
      </div>
      <ul className="space-y-1 max-h-32 overflow-y-auto">
        {results.slice(0, 6).map((t, i) => (
          <li key={i} className="flex items-center gap-2 text-[11px] py-1 px-2 bg-white/[0.02] border border-forge-border/50 rounded">
            {t.status === 'passed' ? (
              <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
            ) : t.status === 'failed' ? (
              <XCircle className="w-3 h-3 text-red-400 shrink-0" />
            ) : (
              <Clock className="w-3 h-3 text-forge-muted/50 shrink-0" />
            )}
            <span className="flex-1 font-mono truncate text-slate-300">{t.name}</span>
            <span className="text-forge-muted/50 tabular-nums text-[10px]">
              {t.duration_ms < 1000 ? `${t.duration_ms}ms` : `${(t.duration_ms / 1000).toFixed(1)}s`}
            </span>
          </li>
        ))}
        {results.length > 6 && (
          <li className="text-[10px] text-forge-muted/50 pl-2">+{results.length - 6} more tests</li>
        )}
      </ul>
    </div>
  );
}

function DeployDetail({ output }: { output: Record<string, unknown> }) {
  const deployUrl = output.deploy_url as string | undefined;
  const dockerImage = output.docker_image as string | undefined;

  return (
    <div className="space-y-2">
      {deployUrl && (
        <div className="flex items-center gap-3 p-3 bg-emerald-500/5 border border-emerald-500/15 rounded-lg">
          <Rocket className="w-4 h-4 text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-medium text-emerald-300">Deployed</p>
            <a
              href={deployUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors truncate block"
            >
              {deployUrl}
            </a>
          </div>
        </div>
      )}
      {dockerImage && (
        <div className="text-[11px] text-forge-muted">
          Image: <span className="font-mono text-slate-300">{dockerImage}</span>
        </div>
      )}
    </div>
  );
}
