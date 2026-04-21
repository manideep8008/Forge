import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookTemplate, Plus, Play, Trash2, ArrowLeft, Loader2, Globe, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { PipelineTemplate } from '../types/collaboration';

export default function TemplatesPage() {
  const { authFetch, user } = useAuth();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', prompt: '', description: '', is_public: false });
  const [saving, setSaving] = useState(false);

  const fetchTemplates = async () => {
    const res = await authFetch('/api/templates');
    if (res.ok) {
      const data = await res.json();
      setTemplates(data.templates ?? []);
    }
    setLoading(false);
  };

  useEffect(() => { fetchTemplates(); }, []); // eslint-disable-line

  const createTemplate = async () => {
    if (!form.name.trim() || !form.prompt.trim()) return;
    setSaving(true);
    const res = await authFetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setForm({ name: '', prompt: '', description: '', is_public: false });
      setShowCreate(false);
      await fetchTemplates();
    }
    setSaving(false);
  };

  const deleteTemplate = async (id: string) => {
    await authFetch(`/api/templates/${id}`, { method: 'DELETE' });
    setTemplates(t => t.filter(x => x.id !== id));
  };

  const launchTemplate = async (prompt: string) => {
    const res = await authFetch('/api/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_text: prompt }),
    });
    if (res.ok) {
      const data = await res.json();
      const id = data.pipeline_id ?? data.id;
      if (id) navigate(`/pipeline/${id}`);
    }
  };

  return (
    <div className="min-h-screen bg-forge-bg p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-forge-muted hover:text-white transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <BookTemplate className="w-5 h-5 text-indigo-400" />
            <h1 className="text-lg font-semibold">Templates</h1>
          </div>
          <button
            onClick={() => setShowCreate(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 btn-primary text-xs rounded-lg"
          >
            <Plus className="w-3.5 h-3.5" />
            New template
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="bg-forge-surface border border-forge-border rounded-xl p-5 mb-5">
            <h2 className="text-sm font-medium mb-3">New template</h2>
            <div className="space-y-3">
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Template name"
                className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500/50"
              />
              <input
                type="text"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Short description (optional)"
                className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500/50"
              />
              <textarea
                value={form.prompt}
                onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
                placeholder="Prompt text — what Forge will build"
                rows={3}
                className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500/50 resize-none"
              />
              <label className="flex items-center gap-2 text-xs text-forge-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_public}
                  onChange={e => setForm(f => ({ ...f, is_public: e.target.checked }))}
                  className="rounded"
                />
                Make public (visible to all users)
              </label>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-xs text-forge-muted hover:text-white transition-colors">Cancel</button>
                <button
                  onClick={createTemplate}
                  disabled={saving || !form.name.trim() || !form.prompt.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 btn-primary text-xs rounded-lg disabled:opacity-50"
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save template
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Template list */}
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-forge-muted" /></div>
        ) : templates.length === 0 ? (
          <p className="text-sm text-forge-muted text-center py-8">No templates yet. Create one above.</p>
        ) : (
          <div className="space-y-3">
            {templates.map(t => (
              <div key={t.id} className="bg-forge-surface border border-forge-border rounded-xl p-4">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {t.is_public ? <Globe className="w-3.5 h-3.5 text-indigo-400 shrink-0" /> : <Lock className="w-3.5 h-3.5 text-forge-muted shrink-0" />}
                    <span className="text-sm font-medium truncate">{t.name}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => launchTemplate(t.prompt)}
                      title="Run this template"
                      className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                    {t.user_id === user?.id && (
                      <button
                        onClick={() => deleteTemplate(t.id)}
                        title="Delete template"
                        className="p-1.5 rounded-lg text-forge-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                {t.description && <p className="text-xs text-forge-muted mb-2">{t.description}</p>}
                <p className="text-xs text-forge-muted/60 font-mono truncate">{t.prompt}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
