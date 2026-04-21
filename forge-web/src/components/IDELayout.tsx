import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Pipeline } from '../types';
import { usePipeline } from '../hooks/usePipeline';
import { useAuth } from '../context/AuthContext';
import Topbar from './Topbar';
import ChatPanel from './ChatPanel';
import PreviewPanel from './PreviewPanel';
import FileTreePanel from './FileTreePanel';
import CommentThread from './CommentThread';

interface IDELayoutProps {
  initialPipelineId?: string;
}

export default function IDELayout({ initialPipelineId }: IDELayoutProps) {
  const navigate = useNavigate();
  const { user, logout, authFetch } = useAuth();
  const [activePipelineId, setActivePipelineId] = useState<string | undefined>(initialPipelineId);
  const [submitting, setSubmitting] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [showComments, setShowComments] = useState(false);

  const { pipeline, connected, events } = usePipeline(activePipelineId);

  // Fetch pipeline list for history
  const fetchPipelines = useCallback(async () => {
    try {
      const res = await authFetch('/api/pipelines');
      if (res.ok) {
        const data = await res.json();
        setPipelines(data.pipelines ?? []);
      }
    } catch { /* ignore */ }
  }, [authFetch]);

  useEffect(() => {
    void fetchPipelines();
  }, [fetchPipelines]);

  const handleSubmit = async (text: string) => {
    setSubmitting(true);
    try {
      const res = await authFetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input_text: text }),
      });
      if (res.ok) {
        const data = await res.json();
        const id = data.pipeline_id ?? data.id;
        if (id) {
          setActivePipelineId(id);
          navigate(`/pipeline/${id}`);
          fetchPipelines();
        }
      }
    } catch {
      // pipeline creation failed — UI already shows submitting=false
    } finally {
      setSubmitting(false);
    }
  };

  const handleModify = async (pipelineId: string, message: string) => {
    try {
      const res = await authFetch(`/api/pipeline/${pipelineId}/modify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (res.ok) {
        const data = await res.json();
        const newId = data.pipeline_id;
        if (newId) {
          setActivePipelineId(newId);
          navigate(`/pipeline/${newId}`);
          await fetchPipelines();
          return true;
        }
      }
    } catch (err) {
      console.error('Failed to modify pipeline:', err);
    }
    return false;
  };

  const handleForkPipeline = async (id: string) => {
    try {
      const res = await authFetch(`/api/pipeline/${id}/fork`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const newId = data.pipeline_id;
        if (newId) {
          setActivePipelineId(newId);
          navigate(`/pipeline/${newId}`);
          await fetchPipelines();
        }
      }
    } catch (err) {
      console.error('Failed to fork pipeline:', err);
    }
  };

  const handleSelectPipeline = (id: string) => {
    setActivePipelineId(id);
    navigate(`/pipeline/${id}`);
  };

  const handleDeletePipeline = async (id: string) => {
    try {
      const res = await authFetch(`/api/pipeline/${id}`, { method: 'DELETE' });
      if (res.ok) {
        if (activePipelineId === id) {
          setActivePipelineId(undefined);
          navigate('/app');
        }
        fetchPipelines();
      }
    } catch {
      // deletion failed silently — list will resync on next poll
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-forge-bg">
      <Topbar
        pipeline={pipeline}
        connected={connected}
        user={user}
        onNew={() => { setActivePipelineId(undefined); navigate('/app'); }}
        onLogout={logout}
      />

      {/* 3-panel grid */}
      <div className="flex-1 grid overflow-hidden" style={{ gridTemplateColumns: '320px 1fr 280px' }}>
        {/* LEFT — Chat */}
        <div className="border-r border-forge-border overflow-hidden flex flex-col">
          <ChatPanel
            pipeline={pipeline}
            connected={connected}
            onSubmit={handleSubmit}
            onModify={handleModify}
            submitting={submitting}
            pipelines={pipelines}
            onSelectPipeline={handleSelectPipeline}
            onDeletePipeline={handleDeletePipeline}
            onForkPipeline={handleForkPipeline}
            onToggleComments={() => setShowComments(v => !v)}
            showComments={showComments}
          />
        </div>

        {/* CENTER — Preview */}
        <div className="overflow-hidden flex flex-col border-r border-forge-border">
          <PreviewPanel pipeline={pipeline} events={events} />
        </div>

        {/* RIGHT — File Tree or Comment Thread */}
        <div className="overflow-hidden flex flex-col">
          {showComments && activePipelineId ? (
            <CommentThread
              pipelineId={activePipelineId}
              onClose={() => setShowComments(false)}
            />
          ) : (
            <FileTreePanel pipeline={pipeline} />
          )}
        </div>
      </div>
    </div>
  );
}
