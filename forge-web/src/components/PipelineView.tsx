import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Wifi, WifiOff, RefreshCw, AlertTriangle } from 'lucide-react';
import { usePipeline } from '../hooks/usePipeline';
import StageProgressBar from './StageProgressBar';
import AgentCard from './AgentCard';
import HITLGate from './HITLGate';
import type { HITLDecision } from '../types';

export default function PipelineView() {
  const { id } = useParams<{ id: string }>();
  const { pipeline, loading, error, connected, refetch } = usePipeline(id);
  const [showHITL, setShowHITL] = useState(false);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-forge-accent animate-spin" />
      </div>
    );
  }

  if (error || !pipeline) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <AlertTriangle className="w-8 h-8 text-red-400 mx-auto" />
          <p className="text-red-400">{error ?? 'Pipeline not found'}</p>
          <button onClick={refetch} className="btn-primary text-sm">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const isHITLStage = pipeline.current_stage === 'hitl' && pipeline.status !== 'completed';

  const handleHITLDecision = (_decision: HITLDecision) => {
    setShowHITL(false);
    refetch();
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-forge-border bg-forge-surface/50">
        <div>
          <h2 className="text-lg font-bold">{pipeline.name || `Pipeline ${id?.slice(0, 8)}`}</h2>
          <p className="text-sm text-forge-muted">{pipeline.input_text || pipeline.description}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Connection status */}
          <span
            className={`flex items-center gap-1.5 text-xs ${
              connected ? 'text-emerald-400' : 'text-slate-500'
            }`}
          >
            {connected ? (
              <Wifi className="w-3.5 h-3.5" />
            ) : (
              <WifiOff className="w-3.5 h-3.5" />
            )}
            {connected ? 'Live' : 'Disconnected'}
          </span>

          {/* Stage counter */}
          {pipeline.stages && (
            <span className="text-xs text-forge-muted">
              {pipeline.stages.filter((s) => s.status === 'completed').length}/{pipeline.stages.length} stages
            </span>
          )}

          {/* Status badge */}
          <span
            className={`px-2.5 py-1 rounded-full text-xs font-medium ${
              pipeline.status === 'completed'
                ? 'bg-emerald-500/20 text-emerald-400'
                : pipeline.status === 'failed'
                  ? 'bg-red-500/20 text-red-400'
                  : pipeline.status === 'running'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'bg-slate-700 text-slate-400'
            }`}
          >
            {pipeline.status}
          </span>

          <button
            onClick={refetch}
            className="p-2 rounded-lg hover:bg-slate-700 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4 text-forge-muted" />
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Stage progress */}
        <StageProgressBar stages={pipeline.stages} />

        {/* Agent outputs */}
        {pipeline.agents.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-forge-muted uppercase tracking-wider">
              Agent Outputs
            </h3>
            <div className="grid grid-cols-1 gap-4">
              {pipeline.agents.map((agent, i) => (
                <AgentCard key={`${agent.agent}-${agent.stage}-${i}`} agent={agent} />
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {pipeline.agents.length === 0 && pipeline.status === 'pending' && (
          <div className="text-center py-12 text-forge-muted">
            <p>Pipeline is queued. Agents will appear here once processing begins.</p>
          </div>
        )}
      </div>

      {/* HITL Banner */}
      {isHITLStage && !showHITL && (
        <div className="p-4 border-t border-forge-border bg-amber-500/10">
          <button
            onClick={() => setShowHITL(true)}
            className="w-full py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-md text-sm font-medium transition-colors"
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
