import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Loader2,
  XCircle,
  Clock,
  Coins,
  Timer,
} from 'lucide-react';
import type { AgentOutput } from '../types';
import DiffViewer from './DiffViewer';

interface AgentCardProps {
  agent: AgentOutput;
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
    completed: {
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      color: 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20',
      label: 'Completed',
    },
    running: {
      icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
      color: 'bg-indigo-400/10 text-indigo-400 border-indigo-400/20',
      label: 'Running',
    },
    failed: {
      icon: <XCircle className="w-3.5 h-3.5" />,
      color: 'bg-red-400/10 text-red-400 border-red-400/20',
      label: 'Failed',
    },
    pending: {
      icon: <Clock className="w-3.5 h-3.5" />,
      color: 'bg-white/5 text-forge-muted border-forge-border',
      label: 'Pending',
    },
  };

  const c = config[status] ?? config.pending;

  return (
    <span className={`badge border ${c.color}`}>
      {c.icon}
      {c.label}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export default function AgentCard({ agent }: AgentCardProps) {
  const [expanded, setExpanded] = useState(agent.status === 'running');

  return (
    <div className={`card overflow-hidden transition-all duration-200 ${
      agent.status === 'running' ? 'shadow-glow-sm border-indigo-500/20' : ''
    }`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 hover:bg-white/[0.02] transition-all duration-150 group"
      >
        <div className="text-forge-muted/60 group-hover:text-forge-muted transition-colors">
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </div>

        <div className="flex-1 flex items-center justify-between min-w-0">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold capitalize text-forge-text">{agent.agent}</h3>
            <StatusBadge status={agent.status} />
          </div>

          <div className="flex items-center gap-4 text-xs text-forge-muted">
            {agent.duration_ms != null && (
              <span className="flex items-center gap-1.5 bg-white/5 px-2 py-0.5 rounded-md">
                <Timer className="w-3 h-3" />
                {formatDuration(agent.duration_ms)}
              </span>
            )}
            {agent.tokens_used != null && (
              <span className="flex items-center gap-1.5 bg-white/5 px-2 py-0.5 rounded-md">
                <Coins className="w-3 h-3" />
                {agent.tokens_used.toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-forge-border p-4 space-y-4 animate-slide-down">
          {/* Streaming content */}
          {agent.streaming_content && (
            <pre className="text-xs text-slate-300 bg-forge-bg rounded-xl p-4 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto border border-forge-border">
              {agent.streaming_content}
              {agent.status === 'running' && (
                <span className="inline-block w-2 h-4 bg-indigo-400 animate-pulse ml-0.5 rounded-sm" />
              )}
            </pre>
          )}

          {/* Diffs for codegen */}
          {agent.diff && agent.diff.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-widest">
                Code Changes
              </h4>
              {agent.diff.map((d, i) => (
                <DiffViewer
                  key={i}
                  filename={d.filename}
                  oldCode={d.old_code}
                  newCode={d.new_code}
                />
              ))}
            </div>
          )}

          {/* Review issues */}
          {agent.review_issues && agent.review_issues.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-widest">
                Review Issues ({agent.review_issues.length})
              </h4>
              <ul className="space-y-1.5">
                {agent.review_issues.map((issue, i) => (
                  <li
                    key={i}
                    className={`flex items-start gap-2 text-xs p-2.5 rounded-lg border ${
                      issue.severity === 'error'
                        ? 'bg-red-500/5 text-red-300 border-red-500/10'
                        : issue.severity === 'warning'
                          ? 'bg-amber-500/5 text-amber-300 border-amber-500/10'
                          : 'bg-indigo-500/5 text-indigo-300 border-indigo-500/10'
                    }`}
                  >
                    <span className="font-mono shrink-0">
                      {issue.file}
                      {issue.line != null ? `:${issue.line}` : ''}
                    </span>
                    <span>{issue.message}</span>
                    {issue.rule && (
                      <span className="text-forge-muted/50 shrink-0">[{issue.rule}]</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Test results */}
          {agent.test_results && agent.test_results.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-widest">
                  Test Results
                </h4>
                {agent.test_coverage != null && (
                  <span className="text-xs text-forge-muted bg-white/5 px-2 py-0.5 rounded-md">
                    Coverage: {agent.test_coverage.toFixed(1)}%
                  </span>
                )}
              </div>
              <ul className="space-y-1.5">
                {agent.test_results.map((test, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 text-xs p-2.5 rounded-lg bg-white/[0.02] border border-forge-border"
                  >
                    {test.status === 'passed' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : test.status === 'failed' ? (
                      <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    ) : (
                      <Clock className="w-3.5 h-3.5 text-forge-muted/50 shrink-0" />
                    )}
                    <span className="flex-1 font-mono">{test.name}</span>
                    <span className="text-forge-muted/50">
                      {formatDuration(test.duration_ms)}
                    </span>
                    {test.error && (
                      <span className="text-red-400 truncate max-w-xs">{test.error}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* File plan (architect agent) */}
          {agent.output && 'file_plan' in agent.output && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-widest">
                File Structure
              </h4>
              <div className="bg-forge-bg rounded-xl p-4 text-xs font-mono space-y-1.5 max-h-64 overflow-y-auto border border-forge-border">
                {Object.entries(
                  (agent.output as Record<string, unknown>).file_plan as Record<string, unknown>
                ).map(([path, desc]) => (
                  <div key={path} className="flex gap-3">
                    <span className="text-emerald-400 shrink-0">{path}</span>
                    <span className="text-forge-muted/50">{String(desc)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Architecture decisions (architect agent) */}
          {agent.output && 'architecture_decisions' in agent.output && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-widest">
                Architecture Decisions
              </h4>
              <ul className="space-y-1.5 text-xs text-slate-300">
                {((agent.output as Record<string, unknown>).architecture_decisions as string[]).map(
                  (decision, i) => (
                    <li key={i} className="flex gap-3 p-2.5 bg-white/[0.02] border border-forge-border rounded-lg">
                      <span className="text-indigo-400 shrink-0 font-medium">{i + 1}.</span>
                      <span>{decision}</span>
                    </li>
                  )
                )}
              </ul>
            </div>
          )}

          {/* Generated files (codegen agent) */}
          {agent.output &&
            typeof agent.output === 'object' &&
            !('file_plan' in agent.output) &&
            !('architecture_decisions' in agent.output) &&
            agent.agent === 'codegen' && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-widest">
                Generated Files ({Object.keys(agent.output).length})
              </h4>
              <div className="bg-forge-bg rounded-xl p-4 text-xs font-mono space-y-1.5 max-h-64 overflow-y-auto border border-forge-border">
                {Object.keys(agent.output).map((path) => (
                  <div key={path} className="text-emerald-400">
                    {path}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Deploy output */}
          {agent.agent === 'deploy' && agent.output && (
            <div className="space-y-3">
              {!!(agent.output as Record<string, unknown>).deploy_url && (
                <div className="flex items-center gap-3 p-4 bg-emerald-500/5 border border-emerald-500/15 rounded-xl shadow-glow-emerald">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-emerald-300">Application Deployed</p>
                    <a
                      href={String((agent.output as Record<string, unknown>).deploy_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      {String((agent.output as Record<string, unknown>).deploy_url)}
                    </a>
                  </div>
                </div>
              )}
              {!!(agent.output as Record<string, unknown>).docker_image && (
                <div className="text-xs text-forge-muted">
                  <span>Image: </span>
                  <span className="font-mono text-slate-300">
                    {String((agent.output as Record<string, unknown>).docker_image)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Monitor output */}
          {agent.agent === 'monitor' && agent.output && 'health_status' in agent.output && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-widest">
                Health Status
              </h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.entries((agent.output as Record<string, unknown>).health_status as Record<string, unknown>).map(([key, val]) => (
                  <div key={key} className="flex justify-between p-2.5 bg-white/[0.02] border border-forge-border rounded-lg">
                    <span className="text-forge-muted capitalize">{key.replace(/_/g, ' ')}</span>
                    <span className={key === 'healthy' && val === true ? 'text-emerald-400' : 'text-slate-300'}>
                      {String(val)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Generic output fallback */}
          {agent.output &&
            !agent.diff &&
            !agent.review_issues &&
            !agent.test_results &&
            !('file_plan' in agent.output) &&
            !('architecture_decisions' in agent.output) &&
            agent.agent !== 'codegen' &&
            agent.agent !== 'deploy' &&
            agent.agent !== 'monitor' && (
            <pre className="text-xs text-slate-300 bg-forge-bg rounded-xl p-4 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto border border-forge-border">
              {JSON.stringify(agent.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
