import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, Send, Loader2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { PipelineComment } from '../types/collaboration';

interface CommentThreadProps {
  pipelineId: string;
  stageName?: string;
  onClose: () => void;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({})) as { detail?: string; error?: string };
  return data.detail ?? data.error ?? fallback;
}

export default function CommentThread({ pipelineId, stageName, onClose }: CommentThreadProps) {
  const { authFetch, user } = useAuth();
  const [comments, setComments] = useState<PipelineComment[]>([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchComments = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch(`/api/pipeline/${pipelineId}/comments`);
      if (!res.ok) {
        throw new Error(await readError(res, 'Failed to load comments'));
      }
      const data = await res.json();
      setComments(data.comments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load comments');
    } finally {
      setLoading(false);
    }
  }, [authFetch, pipelineId]);

  useEffect(() => { void fetchComments(); }, [fetchComments]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [comments]);

  const send = async () => {
    if (!body.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await authFetch(`/api/pipeline/${pipelineId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim(), stage_name: stageName }),
      });
      if (!res.ok) {
        throw new Error(await readError(res, 'Failed to send comment'));
      }
      const c = await res.json() as PipelineComment & { author_email?: string };
      setComments(prev => [...prev, { ...c, author_email: c.author_email ?? user?.email ?? '' }]);
      setBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send comment');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full border-l border-forge-border bg-forge-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-forge-border shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-3.5 h-3.5 text-forge-muted" />
          <span className="text-xs font-medium">
            {stageName ? `Comments · ${stageName}` : 'Comments'}
          </span>
        </div>
        <button onClick={onClose} className="text-forge-muted hover:text-white transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Comments */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading ? (
          <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-forge-muted" /></div>
        ) : comments.length === 0 ? (
          <p className="text-xs text-forge-muted text-center py-4">No comments yet. Be the first!</p>
        ) : (
          comments.map(c => (
            <div key={c.id} className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-forge-text">{c.author_email}</span>
                {c.stage_name && (
                  <span className="text-[10px] bg-forge-bg border border-forge-border rounded px-1.5 py-0.5 text-forge-muted">
                    {c.stage_name}
                  </span>
                )}
              </div>
              <p className="text-xs text-forge-text leading-relaxed">{c.body}</p>
              <p className="text-[10px] text-forge-muted/60">
                {new Date(c.created_at).toLocaleString()}
              </p>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-forge-border p-3">
        <div className="flex gap-2">
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder="Add a comment…"
            rows={2}
            maxLength={2000}
            className="flex-1 bg-forge-bg border border-forge-border rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:border-forge-border-bright resize-none"
          />
          <button
            onClick={send}
            disabled={sending || !body.trim()}
            className="self-end p-2 btn-primary rounded-lg disabled:opacity-50"
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}
