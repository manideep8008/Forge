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

interface HITLGateProps {
  pipelineId: string;
  agents: AgentOutput[];
  onClose: () => void;
  onDecision: (decision: HITLDecision) => void;
}

export default function HITLGate({ pipelineId, agents, onClose, onDecision }: HITLGateProps) {
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reviewAgent = agents.find((a) => a.stage === 'review');
  const testAgent = agents.find((a) => a.stage === 'test');

  const issues = reviewAgent?.review_issues ?? [];
  const tests = testAgent?.test_results ?? [];
  const coverage = testAgent?.test_coverage;

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const passedTests = tests.filter((t) => t.status === 'passed').length;
  const failedTests = tests.filter((t) => t.status === 'failed').length;

  const handleSubmit = async (action: HITLDecision['action']) => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/pipeline/${pipelineId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, comment: comment || undefined }),
      });

      if (!res.ok) throw new Error('Failed to submit decision');

      onDecision({ action, comment: comment || undefined });
    } catch (err) {
      console.error('HITL submission failed:', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-forge-border">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-6 h-6 text-forge-accent" />
            <h2 className="text-lg font-bold">Human-in-the-Loop Review</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-700 transition-colors"
          >
            <X className="w-5 h-5 text-forge-muted" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-800/50 rounded-lg p-3 text-center">
              <div className="flex items-center justify-center gap-1.5 text-red-400">
                <XCircle className="w-4 h-4" />
                <span className="text-2xl font-bold">{errorCount}</span>
              </div>
              <p className="text-xs text-forge-muted mt-1">Errors</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3 text-center">
              <div className="flex items-center justify-center gap-1.5 text-yellow-400">
                <AlertTriangle className="w-4 h-4" />
                <span className="text-2xl font-bold">{warningCount}</span>
              </div>
              <p className="text-xs text-forge-muted mt-1">Warnings</p>
            </div>
            <div className="bg-slate-800/50 rounded-lg p-3 text-center">
              <div className="flex items-center justify-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                <span className="text-2xl font-bold">
                  {passedTests}/{tests.length}
                </span>
              </div>
              <p className="text-xs text-forge-muted mt-1">Tests Passed</p>
            </div>
          </div>

          {/* Coverage bar */}
          {coverage != null && (
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-forge-muted">Test Coverage</span>
                <span
                  className={
                    coverage >= 80
                      ? 'text-emerald-400'
                      : coverage >= 60
                        ? 'text-yellow-400'
                        : 'text-red-400'
                  }
                >
                  {coverage.toFixed(1)}%
                </span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all duration-500 ${
                    coverage >= 80
                      ? 'bg-emerald-400'
                      : coverage >= 60
                        ? 'bg-yellow-400'
                        : 'bg-red-400'
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
              <ul className="space-y-1 max-h-40 overflow-y-auto">
                {issues.map((issue, i) => (
                  <li
                    key={i}
                    className={`text-xs p-2 rounded flex items-start gap-2 ${
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
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Failed tests */}
          {failedTests > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Failed Tests</h3>
              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {tests
                  .filter((t) => t.status === 'failed')
                  .map((test, i) => (
                    <li
                      key={i}
                      className="text-xs p-2 rounded bg-red-400/5 text-red-300 flex items-start gap-2"
                    >
                      <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-mono">{test.name}</span>
                        {test.error && (
                          <p className="text-red-400/70 mt-0.5">{test.error}</p>
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
              className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2
                text-sm text-forge-text placeholder-forge-muted resize-none
                focus:outline-none focus:ring-1 focus:ring-forge-accent focus:border-forge-accent"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 p-5 border-t border-forge-border">
          <button
            onClick={() => handleSubmit('reject')}
            disabled={submitting}
            className="btn-danger flex items-center gap-2 disabled:opacity-50"
          >
            <ShieldX className="w-4 h-4" />
            Reject
          </button>
          <button
            onClick={() => handleSubmit('request_changes')}
            disabled={submitting}
            className="btn-warning flex items-center gap-2 disabled:opacity-50"
          >
            <MessageSquareWarning className="w-4 h-4" />
            Request Changes
          </button>
          <button
            onClick={() => handleSubmit('approve')}
            disabled={submitting}
            className="btn-success flex items-center gap-2 disabled:opacity-50"
          >
            <ShieldCheck className="w-4 h-4" />
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
