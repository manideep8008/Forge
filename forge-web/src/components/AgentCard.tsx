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
      color: 'bg-blue-400/10 text-blue-400 border-blue-400/20',
      label: 'Running',
    },
    failed: {
      icon: <XCircle className="w-3.5 h-3.5" />,
      color: 'bg-red-400/10 text-red-400 border-red-400/20',
      label: 'Failed',
    },
    pending: {
      icon: <Clock className="w-3.5 h-3.5" />,
      color: 'bg-slate-400/10 text-slate-400 border-slate-400/20',
      label: 'Pending',
    },
  };

  const c = config[status] ?? config.pending;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.color}`}>
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
    <div className="card overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 hover:bg-slate-700/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-forge-muted shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-forge-muted shrink-0" />
        )}

        <div className="flex-1 flex items-center justify-between min-w-0">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold capitalize">{agent.agent}</h3>
            <StatusBadge status={agent.status} />
          </div>

          <div className="flex items-center gap-4 text-xs text-forge-muted">
            {agent.duration_ms != null && (
              <span className="flex items-center gap-1">
                <Timer className="w-3 h-3" />
                {formatDuration(agent.duration_ms)}
              </span>
            )}
            {agent.tokens_used != null && (
              <span className="flex items-center gap-1">
                <Coins className="w-3 h-3" />
                {agent.tokens_used.toLocaleString()} tokens
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-forge-border p-4 space-y-4">
          {/* Streaming content */}
          {agent.streaming_content && (
            <pre className="text-xs text-slate-300 bg-slate-900 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
              {agent.streaming_content}
              {agent.status === 'running' && (
                <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse ml-0.5" />
              )}
            </pre>
          )}

          {/* Diffs for codegen */}
          {agent.diff && agent.diff.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-wider">
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
          {agent.review_issues && agent.review_issues.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-wider">
                Review Issues ({agent.review_issues.length})
              </h4>
              <ul className="space-y-1">
                {agent.review_issues.map((issue, i) => (
                  <li
                    key={i}
                    className={`flex items-start gap-2 text-xs p-2 rounded ${
                      issue.severity === 'error'
                        ? 'bg-red-400/5 text-red-300'
                        : issue.severity === 'warning'
                          ? 'bg-yellow-400/5 text-yellow-300'
                          : 'bg-blue-400/5 text-blue-300'
                    }`}
                  >
                    <span className="font-mono shrink-0">
                      {issue.file}
                      {issue.line != null ? `:${issue.line}` : ''}
                    </span>
                    <span>{issue.message}</span>
                    {issue.rule && (
                      <span className="text-slate-500 shrink-0">[{issue.rule}]</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Test results */}
          {agent.test_results && agent.test_results.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-forge-muted uppercase tracking-wider">
                  Test Results
                </h4>
                {agent.test_coverage != null && (
                  <span className="text-xs text-forge-muted">
                    Coverage: {agent.test_coverage.toFixed(1)}%
                  </span>
                )}
              </div>
              <ul className="space-y-1">
                {agent.test_results.map((test, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 text-xs p-2 rounded bg-slate-800/50"
                  >
                    {test.status === 'passed' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : test.status === 'failed' ? (
                      <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    ) : (
                      <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    )}
                    <span className="flex-1 font-mono">{test.name}</span>
                    <span className="text-slate-500">
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

          {/* Generic output fallback */}
          {agent.output && !agent.diff && !agent.review_issues && !agent.test_results && (
            <pre className="text-xs text-slate-300 bg-slate-900 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
              {JSON.stringify(agent.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
