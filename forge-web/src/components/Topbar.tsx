import { Hammer, Plus, Wifi, WifiOff, LogOut, Users, BookTemplate, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Pipeline } from '../types';

interface User {
  id: string;
  email: string;
}

interface TopbarProps {
  pipeline: Pipeline | null;
  connected: boolean;
  user: User | null;
  onNew: () => void;
  onLogout: () => void;
}

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  failed: 'bg-red-500/15 text-red-400 border-red-500/25',
  running: 'bg-white/8 text-forge-text border-forge-border-bright',
  awaiting_approval: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  pending: 'bg-white/5 text-forge-muted border-forge-border',
};

export default function Topbar({ pipeline, connected, user, onNew, onLogout }: TopbarProps) {
  return (
    <header className="h-12 flex items-center justify-between px-4 border-b border-forge-border bg-forge-surface-solid/90 backdrop-blur-xl shrink-0 z-10">
      {/* Brand */}
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 bg-forge-surface border border-forge-border rounded-lg">
          <Hammer className="w-4 h-4 text-forge-text" />
        </div>
        <span className="font-bold text-sm tracking-tight text-forge-text">
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

      {/* Nav links */}
      <div className="hidden md:flex items-center gap-1">
        <Link to="/workspaces" className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-forge-muted hover:text-white hover:bg-white/5 rounded-lg transition-colors">
          <Users className="w-3.5 h-3.5" />Workspaces
        </Link>
        <Link to="/templates" className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-forge-muted hover:text-white hover:bg-white/5 rounded-lg transition-colors">
          <BookTemplate className="w-3.5 h-3.5" />Templates
        </Link>
        <Link to="/schedules" className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-forge-muted hover:text-white hover:bg-white/5 rounded-lg transition-colors">
          <Clock className="w-3.5 h-3.5" />Schedules
        </Link>
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

        {/* User email */}
        {user && (
          <span className="text-xs text-forge-muted hidden sm:block truncate max-w-[140px]">
            {user.email}
          </span>
        )}

        <button
          onClick={onNew}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg btn-primary"
        >
          <Plus className="w-3.5 h-3.5" />
          New
        </button>

        <button
          onClick={onLogout}
          title="Sign out"
          className="flex items-center p-1.5 rounded-lg text-forge-muted hover:text-white hover:bg-white/5 transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
}
