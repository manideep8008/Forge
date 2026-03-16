import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Hammer,
  Plus,
  Search,
  CheckCircle2,
  Loader2,
  Clock,
  XCircle,
} from 'lucide-react';
import type { Pipeline, StageStatus } from '../types';

interface ProjectSidebarProps {
  onNewPipeline: () => void;
  refreshKey: number;
}

function StatusIcon({ status }: { status: StageStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    case 'running':
      return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-red-400" />;
    default:
      return <Clock className="w-4 h-4 text-slate-500" />;
  }
}

export default function ProjectSidebar({ onNewPipeline, refreshKey }: ProjectSidebarProps) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { id: activeId } = useParams<{ id: string }>();

  useEffect(() => {
    const fetchPipelines = async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/pipelines');
        if (res.ok) {
          const data = await res.json();
          setPipelines(Array.isArray(data) ? data : data.pipelines || []);
        }
      } catch {
        console.error('Failed to fetch pipelines');
      } finally {
        setLoading(false);
      }
    };
    fetchPipelines();
  }, [refreshKey]);

  const filtered = pipelines.filter((p) => {
    const term = search.toLowerCase();
    const idMatch = p.id?.toLowerCase().includes(term);
    const textMatch = p.input_text?.toLowerCase().includes(term);
    const intentMatch = p.intent_type?.toLowerCase().includes(term);
    return idMatch || textMatch || intentMatch;
  });

  return (
    <aside className="w-72 bg-forge-surface border-r border-forge-border flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-forge-border">
        <div className="flex items-center gap-2 mb-4">
          <Hammer className="w-6 h-6 text-forge-accent" />
          <h1 className="text-lg font-bold">Forge</h1>
        </div>
        <button
          onClick={onNewPipeline}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New Pipeline
        </button>
      </div>

      {/* Search */}
      <div className="p-3 border-b border-forge-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-forge-muted" />
          <input
            type="text"
            placeholder="Search pipelines..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-forge-bg border border-forge-border rounded-lg pl-9 pr-3 py-2
              text-sm text-forge-text placeholder-forge-muted
              focus:outline-none focus:ring-1 focus:ring-forge-accent focus:border-forge-accent"
          />
        </div>
      </div>

      {/* Pipeline list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-forge-muted animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-forge-muted text-sm">
            {search ? 'No matching pipelines' : 'No pipelines yet'}
          </div>
        ) : (
          <ul className="py-1">
            {filtered.map((pipeline) => (
              <li key={pipeline.id}>
                <button
                  onClick={() => navigate(`/pipeline/${pipeline.id}`)}
                  className={`w-full text-left px-4 py-3 flex items-start gap-3
                    hover:bg-slate-700/50 transition-colors
                    ${activeId === pipeline.id ? 'bg-slate-700/70 border-l-2 border-forge-accent' : ''}`}
                >
                  <StatusIcon status={pipeline.status} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                       {pipeline.intent_type ? `[${pipeline.intent_type}] ` : ''}
                       {pipeline.id?.slice(0, 8) || 'Unknown ID'}
                    </p>
                    <p className="text-xs text-forge-muted truncate mt-0.5" title={pipeline.input_text}>
                      {pipeline.input_text || pipeline.description || 'No description'}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {new Date(pipeline.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
