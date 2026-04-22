import { useState } from 'react';
import { X, Rocket, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface NewPipelineModalProps {
  onClose: () => void;
  onCreated: (id: string) => void;
}

export default function NewPipelineModal({ onClose, onCreated }: NewPipelineModalProps) {
  const { authFetch } = useAuth();
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await authFetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input_text: description.trim(),
        }),
      });

      if (!res.ok) throw new Error(`Failed to create pipeline: ${res.statusText}`);

      const data = await res.json();
      onCreated(data.pipeline_id || data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md animate-fade-in">
      <div className="card w-full max-w-lg shadow-glass-lg border-forge-border-bright animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-forge-border">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-xl">
              <Rocket className="w-5 h-5 text-indigo-400" />
            </div>
            <h2 className="text-lg font-bold">New Pipeline</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
          >
            <X className="w-5 h-5 text-forge-muted" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label htmlFor="feature-request" className="text-sm font-semibold block mb-2">
              Feature Request
            </label>
            <textarea
              id="feature-request"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the feature you want to build. Be as specific as possible about requirements, constraints, and expected behavior..."
              rows={6}
              autoFocus
              className="input-modern resize-none"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-500/5 border border-red-500/10 rounded-xl px-3 py-2.5">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !description.trim()}
              className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:pointer-events-none text-sm"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Rocket className="w-4 h-4" />
              )}
              Launch Pipeline
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
