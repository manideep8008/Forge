import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Pipeline } from '../types';
import { usePipeline } from '../hooks/usePipeline';
import Topbar from './Topbar';
import ChatPanel from './ChatPanel';
import PreviewPanel from './PreviewPanel';
import FileTreePanel from './FileTreePanel';

interface IDELayoutProps {
  initialPipelineId?: string;
}

export default function IDELayout({ initialPipelineId }: IDELayoutProps) {
  const navigate = useNavigate();
  const [activePipelineId, setActivePipelineId] = useState<string | undefined>(initialPipelineId);
  const [submitting, setSubmitting] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);

  const { pipeline, connected } = usePipeline(activePipelineId);

  // Fetch pipeline list for history
  const fetchPipelines = useCallback(async () => {
    try {
      const res = await fetch('/api/pipelines');
      if (res.ok) {
        const data = await res.json();
        setPipelines(data.pipelines ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  useState(() => { fetchPipelines(); });

  const handleSubmit = async (text: string) => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/pipeline', {
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
    } catch (err) {
      console.error('Failed to create pipeline:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleModify = async (pipelineId: string, message: string) => {
    try {
      const res = await fetch(`/api/pipeline/${pipelineId}/modify`, {
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
          fetchPipelines();
        }
      }
    } catch (err) {
      console.error('Failed to modify pipeline:', err);
    }
  };

  const handleSelectPipeline = (id: string) => {
    setActivePipelineId(id);
    navigate(`/pipeline/${id}`);
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-forge-bg">
      <Topbar
        pipeline={pipeline}
        connected={connected}
        onNew={() => { setActivePipelineId(undefined); navigate('/'); }}
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
          />
        </div>

        {/* CENTER — Preview */}
        <div className="overflow-hidden flex flex-col border-r border-forge-border">
          <PreviewPanel pipeline={pipeline} />
        </div>

        {/* RIGHT — File Tree */}
        <div className="overflow-hidden flex flex-col">
          <FileTreePanel pipeline={pipeline} />
        </div>
      </div>
    </div>
  );
}
