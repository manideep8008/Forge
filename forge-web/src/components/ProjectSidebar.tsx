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
  Trash2,
} from 'lucide-react';
import type { Pipeline, StageStatus } from '../types';
import { useAuth } from '../context/AuthContext';

interface ProjectSidebarProps {
  onNewPipeline: () => void;
  refreshKey: number;
  onRefresh: () => void;
}

function StatusIcon({ status }: { status: StageStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    case 'running':
      return <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-red-400" />;
    default:
      return <Clock className="w-4 h-4 text-forge-muted/50" />;
  }
}

export default function ProjectSidebar({ onNewPipeline, refreshKey, onRefresh }: ProjectSidebarProps) {
  const { authFetch } = useAuth();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { id: activeId } = useParams<{ id: string }>();

  useEffect(() => {
    const fetchPipelines = async () => {
      try {
        setLoading(true);
        const res = await authFetch('/api/pipelines');
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
  }, [refreshKey, authFetch]);

  const handleDelete = async (e: React.MouseEvent, pipelineId: string) => {
    e.stopPropagation();
    if (!confirm('Delete this pipeline? This cannot be undone.')) return;

    setDeletingId(pipelineId);
    try {
      const res = await authFetch(`/api/pipeline/${pipelineId}`, { method: 'DELETE' });
      if (res.ok) {
        setPipelines((prev) => prev.filter((p) => p.id !== pipelineId));
        if (activeId === pipelineId) {
          navigate('/');
        }
        onRefresh();
      }
    } catch {
      console.error('Failed to delete pipeline');
    } finally {
      setDeletingId(null);
    }
  };

  const filtered = pipelines.filter((p) => {
    const term = search.toLowerCase();
    const idMatch = p.id?.toLowerCase().includes(term);
    const textMatch = p.input_text?.toLowerCase().includes(term);
    const intentMatch = p.intent_type?.toLowerCase().includes(term);
    return idMatch || textMatch || intentMatch;
  });

  return (
    <aside className="w-72 bg-forge-surface-solid/90 backdrop-blur-xl border-r border-forge-border flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-forge-border">
        <div className="flex items-center gap-2.5 mb-4">
          <div className="p-1.5 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 rounded-lg">
            <Hammer className="w-5 h-5 text-indigo-400" />
          </div>
          <h1 className="text-lg font-bold bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent">
            Forge
          </h1>
        </div>
        <button
          onClick={onNewPipeline}
          className="btn-primary w-full flex items-center justify-center gap-2 text-sm"
        >
          <Plus className="w-4 h-4" />
          New Pipeline
        </button>
      </div>

      {/* Search */}
      <div className="p-3 border-b border-forge-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-forge-muted/60" />
          <input
            type="text"
            placeholder="Search pipelines..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-modern pl-9"
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
                    transition-all duration-150 group
                    ${activeId === pipeline.id
                      ? 'bg-indigo-500/10 border-l-2 border-indigo-400'
                      : 'hover:bg-white/[0.03] border-l-2 border-transparent'
                    }`}
                >
                  <div className="mt-0.5">
                    <StatusIcon status={pipeline.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${
                      activeId === pipeline.id ? 'text-indigo-200' : 'text-forge-text group-hover:text-white'
                    }`}>
                       {pipeline.intent_type ? `[${pipeline.intent_type}] ` : ''}
                       {pipeline.id?.slice(0, 8) || 'Unknown ID'}
                    </p>
                    <p className="text-xs text-forge-muted truncate mt-0.5" title={pipeline.input_text}>
                      {pipeline.input_text || pipeline.description || 'No description'}
                    </p>
                    <p className="text-[11px] text-forge-muted/50 mt-1">
                      {new Date(pipeline.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  {/* Delete button */}
                  <div
                    className="mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => handleDelete(e, pipeline.id)}
                  >
                    {deletingId === pipeline.id ? (
                      <Loader2 className="w-3.5 h-3.5 text-forge-muted animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5 text-forge-muted hover:text-red-400 transition-colors cursor-pointer" />
                    )}
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
