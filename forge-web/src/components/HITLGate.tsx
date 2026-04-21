import { useState } from 'react';
import {
  ShieldCheck,
  ShieldX,
  MessageSquareWarning,
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import type { AgentOutput, HITLDecision } from '../types';
import { useAuth } from '../context/AuthContext';

interface HITLGateProps {
  pipelineId: string;
  agents: AgentOutput[];
  onClose: () => void;
  onDecision: (decision: HITLDecision) => void;
  /** When true, renders inline (no full-screen overlay). */
  compact?: boolean;
}

export default function HITLGate({ pipelineId, agents, onClose, onDecision, compact: _compact }: HITLGateProps) {
  const { authFetch } = useAuth();
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const reviewAgent = agents.find((a) => a.stage === 'review');
  const testAgent = agents.find((a) => a.stage === 'test');

  const issues = (reviewAgent?.output as any)?.issues ?? [];
  const tests = (testAgent?.output as any)?.test_results ?? [];
  const coverage = (testAgent?.output as any)?.coverage_percent;

  const errorCount = issues.filter((i: any) => i.severity === 'error').length;
  const warningCount = issues.filter((i: any) => i.severity === 'warning').length;
  const passedTests = tests.filter((t: any) => t.status === 'passed').length;
  const failedTests = tests.filter((t: any) => t.status === 'failed').length;

  const handleSubmit = async (action: HITLDecision['action']) => {
    setSubmitting(true);
    setSubmitError(null);
    const decisionMap: Record<string, string> = {
      approve: 'approve',
      reject: 'reject',
      request_changes: 'modify',
    };
    try {
      const res = await authFetch(`/api/pipeline/${pipelineId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipeline_id: pipelineId,
          decision: decisionMap[action] || action,
          comments: comment || undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to submit decision: ${res.status} ${body}`);
      }

      onDecision({ action, comment: comment || undefined });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md animate-fade-in">
      <div className="card w-full max-w-2xl max-h-[80vh] flex flex-col shadow-glass-lg border-forge-border-bright animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-forge-border">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-xl">
              <ShieldCheck className="w-5 h-5 text-indigo-400" />
            </div>
            <h2 className="text-lg font-bold">Human-in-the-Loop Review</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
          >
            <X className="w-5 h-5 text-forge-muted" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-red-500/5 border border-red-500/10 rounded-xl p-4 text-center">
              <div className="flex items-center justify-center gap-1.5 text-red-400">
                <XCircle className="w-4 h-4" />
                <span className="text-2xl font-bold">{errorCount}</span>
              </div>
              <p className="text-xs text-forge-muted mt-1.5">Errors</p>
            </div>
            <div className="bg-amber-500/5 border border-amber-500/10 rounded-xl p-4 text-center">
              <div className="flex items-center justify-center gap-1.5 text-amber-400">
                <AlertTriangle className="w-4 h-4" />
                <span className="text-2xl font-bold">{warningCount}</span>
              </div>
              <p className="text-xs text-forge-muted mt-1.5">Warnings</p>
            </div>
            <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-4 text-center">
              <div className="flex items-center justify-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                <span className="text-2xl font-bold">
                  {passedTests}/{tests.length}
                </span>
              </div>
              <p className="text-xs text-forge-muted mt-1.5">Tests Passed</p>
            </div>
          </div>

          {/* Coverage bar */}
          {coverage != null && (
            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="text-forge-muted">Test Coverage</span>
                <span
                  className={`font-medium ${
                    coverage >= 80
                      ? 'text-emerald-400'
                      : coverage >= 60
                        ? 'text-amber-400'
                        : 'text-red-400'
                  }`}
                >
                  {coverage.toFixed(1)}%
                </span>
              </div>
              <div className="w-full bg-forge-bg rounded-full h-2 overflow-hidden">
                <div
                  className={`h-2 rounded-full transition-all duration-700 ${
                    coverage >= 80
                      ? 'bg-gradient-to-r from-emerald-500 to-emerald-400'
                      : coverage >= 60
                        ? 'bg-gradient-to-r from-amber-500 to-amber-400'
                        : 'bg-gradient-to-r from-red-500 to-red-400'
                  }`}
                  style={{ width: `${Math.min(coverage, 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* Issue list */}
          {issues.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Review Issues</h3>
              <ul className="space-y-1.5 max-h-40 overflow-y-auto">
                {issues.map((issue: any, i: number) => (
                  <li
                    key={i}
                    className={`text-xs p-2.5 rounded-lg flex items-start gap-2 border ${
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
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Failed tests */}
          {failedTests > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Failed Tests</h3>
              <ul className="space-y-1.5 max-h-32 overflow-y-auto">
                {tests
                  .filter((t: any) => t.status === 'failed')
                  .map((test: any, i: number) => (
                    <li
                      key={i}
                      className="text-xs p-2.5 rounded-lg bg-red-500/5 text-red-300 flex items-start gap-2 border border-red-500/10"
                    >
                      <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-mono">{test.name}</span>
                        {test.error && (
                          <p className="text-red-400/60 mt-0.5">{test.error}</p>
                        )}
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* Comment */}
          <div>
            <label htmlFor="hitl-comment" className="text-sm font-semibold block mb-2">
              Comment (optional)
            </label>
            <textarea
              id="hitl-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add context for your decision..."
              rows={3}
              className="input-modern resize-none"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-3 p-5 border-t border-forge-border">
          {submitError && (
            <p className="text-xs text-red-400">{submitError}</p>
          )}
          <div className="flex items-center gap-3 ml-auto">
          <button
            onClick={() => handleSubmit('reject')}
            disabled={submitting}
            className="btn-danger flex items-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
          >
            <ShieldX className="w-4 h-4" />
            Reject
          </button>
          <button
            onClick={() => handleSubmit('request_changes')}
            disabled={submitting}
            className="btn-warning flex items-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
          >
            <MessageSquareWarning className="w-4 h-4" />
            Request Changes
          </button>
          <button
            onClick={() => handleSubmit('approve')}
            disabled={submitting}
            className="btn-success flex items-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
          >
            <ShieldCheck className="w-4 h-4" />
            Approve
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
