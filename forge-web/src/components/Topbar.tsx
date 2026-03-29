import { Hammer, Plus, Wifi, WifiOff } from 'lucide-react';
import type { Pipeline } from '../types';

interface TopbarProps {
  pipeline: Pipeline | null;
  connected: boolean;
  onNew: () => void;
}

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  failed: 'bg-red-500/15 text-red-400 border-red-500/25',
  running: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25',
  awaiting_approval: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  pending: 'bg-white/5 text-forge-muted border-forge-border',
};

export default function Topbar({ pipeline, connected, onNew }: TopbarProps) {
  return (
    <header className="h-12 flex items-center justify-between px-4 border-b border-forge-border bg-forge-surface-solid/80 backdrop-blur-xl shrink-0 z-10">
      {/* Brand */}
      <div className="flex items-center gap-2.5">
        <div className="relative">
          <div className="absolute inset-0 bg-indigo-500/30 rounded-lg blur-md" />
          <div className="relative p-1.5 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/30 rounded-lg">
            <Hammer className="w-4 h-4 text-indigo-400" />
          </div>
        </div>
        <span className="font-bold text-sm tracking-tight bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent">
          Forge
        </span>
      </div>

      {/* Pipeline name + status */}
      <div className="flex items-center gap-2 min-w-0">
        {pipeline ? (
          <>
            <span className="text-sm font-medium truncate max-w-xs">
              {pipeline.name || `Pipeline ${pipeline.id.slice(0, 8)}`}
            </span>
            <span className={`badge border text-xs ${STATUS_STYLES[pipeline.status] ?? STATUS_STYLES.pending}`}>
              {pipeline.status.replace('_', ' ')}
            </span>
          </>
        ) : (
          <span className="text-sm text-forge-muted">No active pipeline</span>
        )}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-3">
        {/* WS connection dot — only meaningful once a pipeline is active */}
        {pipeline && (
          <span className={`flex items-center gap-1.5 text-xs ${connected ? 'text-emerald-400' : 'text-forge-muted/40'}`}>
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
          </span>
        )}

        <button
          onClick={onNew}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg btn-primary"
        >
          <Plus className="w-3.5 h-3.5" />
          New
        </button>
      </div>
    </header>
  );
}
