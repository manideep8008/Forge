import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Loader2,
  Wifi,
  WifiOff,
  RefreshCw,
  AlertTriangle,
  Trash2,
  StopCircle,
  RotateCcw,
  Copy,
  ExternalLink,
} from 'lucide-react';
import { usePipeline } from '../hooks/usePipeline';
import StageProgressBar from './StageProgressBar';
import AgentCard from './AgentCard';
import HITLGate from './HITLGate';
import type { HITLDecision } from '../types';

const ACTIVE_STATUSES = new Set(['pending', 'running', 'hitl']);

export default function PipelineView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { pipeline, loading, error, connected, refetch } = usePipeline(id);
  const [showHITL, setShowHITL] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isHITLStage = pipeline
    ? (pipeline.current_stage === 'hitl' || pipeline.status === 'awaiting_approval') && pipeline.status !== 'completed'
    : false;

  const isActive = pipeline ? ACTIVE_STATUSES.has(pipeline.status) : false;
  const isFailed = pipeline?.status === 'failed';

  // Auto-open HITL modal when pipeline reaches awaiting_approval
  useEffect(() => {
    if (isHITLStage && !showHITL) {
      setShowHITL(true);
    }
  }, [isHITLStage]);

  const handleAction = async (action: 'cancel' | 'delete' | 'retry') => {
    if (!id) return;

    if (action === 'delete' && !confirm('Delete this pipeline? This cannot be undone.')) return;
    if (action === 'cancel' && !confirm('Cancel this running pipeline?')) return;

    setActionLoading(action);
    try {
      const method = action === 'delete' ? 'DELETE' : 'POST';
      const url =
        action === 'delete'
          ? `/api/pipeline/${id}`
          : `/api/pipeline/${id}/${action}`;

      const res = await fetch(url, { method });
      if (res.ok) {
        if (action === 'delete') {
          navigate('/');
        } else {
          refetch();
        }
      }
    } catch {
      console.error(`Failed to ${action} pipeline`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCopyId = () => {
    if (id) {
      navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-mesh">
        <div className="relative">
          <div className="absolute inset-0 bg-indigo-500/20 rounded-full blur-xl animate-glow-pulse" />
          <Loader2 className="relative w-8 h-8 text-indigo-400 animate-spin" />
        </div>
      </div>
    );
  }

  if (error || !pipeline) {
    return (
      <div className="flex-1 flex items-center justify-center bg-mesh">
        <div className="text-center space-y-4 animate-fade-in">
          <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl inline-block">
            <AlertTriangle className="w-8 h-8 text-red-400" />
          </div>
          <p className="text-red-400 font-medium">{error ?? 'Pipeline not found'}</p>
          <button onClick={refetch} className="btn-primary text-sm">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const handleHITLDecision = (_decision: HITLDecision) => {
    setShowHITL(false);
    refetch();
  };

  const statusStyles: Record<string, string> = {
    completed: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
    failed: 'bg-red-500/10 text-red-400 border border-red-500/20',
    running: 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20',
    awaiting_approval: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
    cancelled: 'bg-forge-muted/10 text-forge-muted border border-forge-border',
    pending: 'bg-white/5 text-forge-muted border border-forge-border',
  };

  // Find deploy URL from agents
  const deployAgent = pipeline.agents.find((a) => a.agent === 'deploy' || a.agent === 'cicd');
  const deployUrl = (deployAgent?.output as Record<string, unknown>)?.deploy_url as string | undefined;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-forge-border bg-forge-surface-solid/60 backdrop-blur-xl">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold truncate">
              {pipeline.name || `Pipeline ${id?.slice(0, 8)}`}
            </h2>
            <button
              onClick={handleCopyId}
              className="p-1 rounded hover:bg-white/5 transition-colors"
              title="Copy pipeline ID"
            >
              <Copy className={`w-3.5 h-3.5 ${copied ? 'text-emerald-400' : 'text-forge-muted'}`} />
            </button>
          </div>
          <p className="text-sm text-forge-muted truncate mt-0.5">
            {pipeline.input_text || pipeline.description}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Connection status */}
          <span
            className={`flex items-center gap-1.5 text-xs ${connected ? 'text-emerald-400' : 'text-forge-muted/50'
              }`}
          >
            {connected ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                </span>
                <Wifi className="w-3.5 h-3.5" />
              </>
            ) : (
              <WifiOff className="w-3.5 h-3.5" />
            )}
            {connected ? 'Live' : 'Disconnected'}
          </span>

          {/* Stage counter */}
          {pipeline.stages && (
            <span className="text-xs text-forge-muted bg-white/5 px-2 py-1 rounded-lg">
              {pipeline.stages.filter((s) => s.status === 'completed').length}/{pipeline.stages.length} stages
            </span>
          )}

          {/* Status badge */}
          <span
            className={`badge ${statusStyles[pipeline.status] ?? 'bg-white/5 text-forge-muted border border-forge-border'
              }`}
          >
            {pipeline.status}
          </span>

          {/* Deploy link */}
          {deployUrl && (
            <a
              href={deployUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded-xl hover:bg-emerald-500/10 transition-all group"
              title="Open deployed app"
            >
              <ExternalLink className="w-4 h-4 text-emerald-400 group-hover:text-emerald-300" />
            </a>
          )}

          {/* Action buttons */}
          {isActive && (
            <button
              onClick={() => handleAction('cancel')}
              disabled={actionLoading === 'cancel'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                bg-amber-500/10 text-amber-400 border border-amber-500/20
                hover:bg-amber-500/20 transition-all disabled:opacity-50"
              title="Cancel pipeline"
            >
              {actionLoading === 'cancel' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <StopCircle className="w-3.5 h-3.5" />
              )}
              Cancel
            </button>
          )}

          {isFailed && (
            <button
              onClick={() => handleAction('retry')}
              disabled={actionLoading === 'retry'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                bg-indigo-500/10 text-indigo-400 border border-indigo-500/20
                hover:bg-indigo-500/20 transition-all disabled:opacity-50"
              title="Retry pipeline"
            >
              {actionLoading === 'retry' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              Retry
            </button>
          )}

          <button
            onClick={() => handleAction('delete')}
            disabled={actionLoading === 'delete'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
              bg-red-500/10 text-red-400 border border-red-500/20
              hover:bg-red-500/20 transition-all disabled:opacity-50"
            title="Delete pipeline"
          >
            {actionLoading === 'delete' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            Delete
          </button>

          <button
            onClick={refetch}
            className="p-2 rounded-xl hover:bg-white/5 transition-all duration-150 group"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4 text-forge-muted group-hover:text-forge-text transition-colors" />
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-mesh">
        {/* Stage progress */}
        <div className="animate-slide-up">
          <StageProgressBar stages={pipeline.stages} />
        </div>

        {/* Agent outputs */}
        {pipeline.agents.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-forge-muted uppercase tracking-widest">
              Agent Outputs
            </h3>
            <div className="grid grid-cols-1 gap-4">
              {pipeline.agents.map((agent, i) => (
                <div key={`${agent.agent}-${agent.stage}-${i}`} className="animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
                  <AgentCard agent={agent} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {pipeline.agents.length === 0 && pipeline.status === 'pending' && (
          <div className="text-center py-16 text-forge-muted animate-fade-in">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white/5 rounded-full text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Pipeline is queued. Agents will appear once processing begins.
            </div>
          </div>
        )}

        {/* Cancelled state */}
        {(pipeline.status as string) === 'cancelled' && (
          <div className="text-center py-16 text-forge-muted animate-fade-in">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white/5 rounded-full text-sm">
              <StopCircle className="w-4 h-4" />
              Pipeline was cancelled.
            </div>
          </div>
        )}
      </div>

      {/* HITL Banner */}
      {isHITLStage && !showHITL && (
        <div className="p-4 border-t border-amber-500/20 bg-amber-500/5 backdrop-blur-sm animate-slide-up">
          <button
            onClick={() => setShowHITL(true)}
            className="btn-warning w-full flex items-center justify-center gap-2"
          >
            Review & Approve Deployment
          </button>
        </div>
      )}

      {/* HITL Modal */}
      {showHITL && (
        <HITLGate
          pipelineId={pipeline.id}
          agents={pipeline.agents}
          onClose={() => setShowHITL(false)}
          onDecision={handleHITLDecision}
        />
      )}
    </div>
  );
}
