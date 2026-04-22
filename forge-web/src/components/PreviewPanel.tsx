import { useState } from 'react';
import {
  ExternalLink,
  RefreshCw,
  Monitor,
  Layers,
  Activity,
  CheckCircle2,
  Loader2,
  XCircle,
} from 'lucide-react';
import type { Pipeline, PipelineEvent } from '../types';
import StageProgressBar from './StageProgressBar';
import StageDetailCard from './StageDetailCard';
import ActivityFeed from './ActivityFeed';

interface PreviewPanelProps {
  pipeline: Pipeline | null;
  events?: PipelineEvent[];
}

type Tab = 'preview' | 'progress';

export default function PreviewPanel({ pipeline, events = [] }: PreviewPanelProps) {
  const [tab, setTab] = useState<Tab>('progress');
  const [iframeKey, setIframeKey] = useState(0);

  // Find deploy URL from agents
  const deployAgent = pipeline?.agents.find((a) => a.agent === 'deploy' || a.agent === 'cicd');
  const deployUrl = (deployAgent?.output as Record<string, unknown> | undefined)?.deploy_url as string | undefined;

  // Auto-switch to preview when deploy URL is available
  const effectiveTab = deployUrl ? tab : 'progress';

  // Pipeline summary stats
  const completedStages = pipeline?.stages.filter((s) => s.status === 'completed').length ?? 0;
  const totalStages = pipeline?.stages.length ?? 0;
  const totalTokens = pipeline?.agents.reduce((sum, a) => sum + (a.tokens_used ?? 0), 0) ?? 0;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-forge-bg/20">
      {/* Tab bar */}
      <div className="flex items-center border-b border-forge-border shrink-0 px-2 pt-1 gap-1">
        <button
          onClick={() => setTab('progress')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors border-b-2 ${
            effectiveTab === 'progress'
              ? 'text-indigo-400 border-indigo-400'
              : 'text-forge-muted border-transparent hover:text-forge-text'
          }`}
        >
          <Layers className="w-3 h-3" />
          Progress
        </button>
        <button
          onClick={() => setTab('preview')}
          disabled={!deployUrl}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors border-b-2 disabled:opacity-40 disabled:cursor-not-allowed ${
            effectiveTab === 'preview'
              ? 'text-emerald-400 border-emerald-400'
              : 'text-forge-muted border-transparent hover:text-forge-text'
          }`}
        >
          <Monitor className="w-3 h-3" />
          Live Preview
          {deployUrl && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
            </span>
          )}
        </button>

        {/* Spacer + actions */}
        <div className="ml-auto flex items-center gap-2 pb-1">
          {/* Quick stats */}
          {pipeline && effectiveTab === 'progress' && (
            <div className="flex items-center gap-2 text-[10px] text-forge-muted/60">
              {completedStages > 0 && (
                <span className="flex items-center gap-1 bg-white/5 px-1.5 py-0.5 rounded">
                  {completedStages}/{totalStages}
                </span>
              )}
              {totalTokens > 0 && (
                <span className="flex items-center gap-1 bg-white/5 px-1.5 py-0.5 rounded tabular-nums">
                  {totalTokens.toLocaleString()} tok
                </span>
              )}
            </div>
          )}

          {effectiveTab === 'preview' && deployUrl && (
            <>
              <button
                onClick={() => setIframeKey((k) => k + 1)}
                className="p-1.5 rounded hover:bg-white/5 text-forge-muted hover:text-forge-text transition-colors"
                title="Reload preview"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <a
                href={deployUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 rounded hover:bg-emerald-500/10 text-emerald-400 hover:text-emerald-300 transition-colors"
                title="Open in new tab"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden relative">
        {effectiveTab === 'progress' ? (
          <div className="h-full overflow-y-auto p-4 space-y-4 bg-mesh">
            {!pipeline ? (
              // Empty state
              <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
                <div className="relative">
                  <div className="absolute inset-0 bg-indigo-500/20 rounded-2xl blur-xl animate-glow-pulse" />
                  <div className="relative p-6 bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 rounded-2xl">
                    <span className="text-5xl">🔨</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold text-sm">Ready to forge</h3>
                  <p className="text-xs text-forge-muted max-w-xs">
                    Type a prompt in the chat to start building. Pipeline progress will appear here in real-time.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* Stage progress bar */}
                <StageProgressBar stages={pipeline.stages} />

                {/* Active stage detail card */}
                {(pipeline.status === 'running' || pipeline.status === 'completed' || pipeline.status === 'failed' || pipeline.status === 'awaiting_approval') && (
                  <div className="animate-slide-up">
                    <StageDetailCard pipeline={pipeline} />
                  </div>
                )}

                {/* Completion summary */}
                {pipeline.status === 'completed' && (
                  <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl animate-slide-up">
                    <div className="flex items-center gap-2 mb-1">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <p className="text-xs font-semibold text-emerald-400">Pipeline Complete</p>
                    </div>
                    {deployUrl ? (
                      <p className="text-xs text-emerald-300/70">
                        App deployed at{' '}
                        <a href={deployUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                          {deployUrl}
                        </a>
                        {' '}— switch to Live Preview tab ↑
                      </p>
                    ) : (
                      <p className="text-xs text-emerald-300/70">All stages completed successfully.</p>
                    )}
                  </div>
                )}

                {/* Failed summary */}
                {pipeline.status === 'failed' && (
                  <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl animate-slide-up">
                    <div className="flex items-center gap-2 mb-1">
                      <XCircle className="w-4 h-4 text-red-400" />
                      <p className="text-xs font-semibold text-red-400">Pipeline Failed</p>
                    </div>
                    <p className="text-xs text-red-300/70">Check the stage details above for error information.</p>
                  </div>
                )}

                {/* Activity Feed */}
                {events.length > 0 && (
                  <div className="animate-slide-up">
                    <div className="flex items-center gap-2 mb-3">
                      <Activity className="w-3.5 h-3.5 text-forge-muted/50" />
                      <h3 className="text-[10px] font-semibold text-forge-muted/50 uppercase tracking-widest">
                        Activity ({events.length})
                      </h3>
                    </div>
                    <div className="card p-4">
                      <ActivityFeed events={events} />
                    </div>
                  </div>
                )}

                {/* Minimal fallback when we have a pipeline but no events yet */}
                {events.length === 0 && pipeline.status === 'running' && (
                  <div className="card p-4 animate-slide-up">
                    <div className="flex items-center gap-2 mb-3">
                      <Activity className="w-3.5 h-3.5 text-forge-muted/50" />
                      <h3 className="text-[10px] font-semibold text-forge-muted/50 uppercase tracking-widest">
                        Activity
                      </h3>
                    </div>
                    <div className="flex items-center justify-center py-4 text-forge-muted/50 text-xs">
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
                      Waiting for pipeline events…
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          // Live iframe preview
          deployUrl ? (
            <iframe
              key={iframeKey}
              src={deployUrl}
              className="w-full h-full border-0 bg-white"
              title="Live Preview"
              sandbox="allow-scripts allow-forms allow-popups"
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-forge-muted">
              <Monitor className="w-8 h-8 opacity-30" />
              <p className="text-xs">Preview will appear once the app is deployed</p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
