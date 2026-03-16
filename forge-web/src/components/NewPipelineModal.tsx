import { useState } from 'react';
import { X, Rocket, Loader2 } from 'lucide-react';

interface NewPipelineModalProps {
  onClose: () => void;
  onCreated: (id: string) => void;
}

export default function NewPipelineModal({ onClose, onCreated }: NewPipelineModalProps) {
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          input_text: description.trim(),
          user_id: 'test-user' // hardcoded for now, normally from auth
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-forge-border">
          <div className="flex items-center gap-3">
            <Rocket className="w-5 h-5 text-forge-accent" />
            <h2 className="text-lg font-bold">New Pipeline</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-700 transition-colors"
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
              className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2
                text-sm text-forge-text placeholder-forge-muted resize-none
                focus:outline-none focus:ring-1 focus:ring-forge-accent focus:border-forge-accent"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-400/5 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-forge-muted hover:text-forge-text transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !description.trim()}
              className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
