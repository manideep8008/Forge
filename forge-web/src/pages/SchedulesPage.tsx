import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Plus, Trash2, ArrowLeft, Loader2, ToggleLeft, ToggleRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { ScheduledPipeline, PipelineTemplate } from '../types/collaboration';

export default function SchedulesPage() {
  const { authFetch } = useAuth();
  const [schedules, setSchedules] = useState<ScheduledPipeline[]>([]);
  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ template_id: '', cron_expr: '0 9 * * 1' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fetchAll = async () => {
    const [sRes, tRes] = await Promise.all([
      authFetch('/api/schedules'),
      authFetch('/api/templates'),
    ]);
    if (sRes.ok) setSchedules((await sRes.json()).schedules ?? []);
    if (tRes.ok) setTemplates((await tRes.json()).templates ?? []);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []); // eslint-disable-line

  const createSchedule = async () => {
    if (!form.template_id || !form.cron_expr.trim()) return;
    setSaving(true);
    setError('');
    const res = await authFetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setForm({ template_id: '', cron_expr: '0 9 * * 1' });
      setShowCreate(false);
      await fetchAll();
    } else {
      const data = await res.json().catch(() => ({})) as { detail?: string };
      setError(data.detail ?? 'Failed to create schedule');
    }
    setSaving(false);
  };

  const toggleSchedule = async (id: string, enabled: boolean) => {
    const res = await authFetch(`/api/schedules/${id}?enabled=${!enabled}`, { method: 'PATCH' });
    if (res.ok) setSchedules(s => s.map(x => x.id === id ? { ...x, enabled: !enabled } : x));
  };

  const deleteSchedule = async (id: string) => {
    await authFetch(`/api/schedules/${id}`, { method: 'DELETE' });
    setSchedules(s => s.filter(x => x.id !== id));
  };

  const PRESETS = [
    { label: 'Every Monday 9am', value: '0 9 * * 1' },
    { label: 'Daily midnight', value: '0 0 * * *' },
    { label: 'Every hour', value: '0 * * * *' },
    { label: 'Every 6 hours', value: '0 */6 * * *' },
  ];

  return (
    <div className="min-h-screen bg-forge-bg p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-forge-muted hover:text-white transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <Clock className="w-5 h-5 text-indigo-400" />
            <h1 className="text-lg font-semibold">Scheduled Pipelines</h1>
          </div>
          <button
            onClick={() => setShowCreate(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 btn-primary text-xs rounded-lg"
          >
            <Plus className="w-3.5 h-3.5" />
            New schedule
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="bg-forge-surface border border-forge-border rounded-xl p-5 mb-5">
            <h2 className="text-sm font-medium mb-3">New schedule</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-forge-muted mb-1.5">Template</label>
                <select
                  value={form.template_id}
                  onChange={e => setForm(f => ({ ...f, template_id: e.target.value }))}
                  className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500/50"
                >
                  <option value="">Select a template…</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-forge-muted mb-1.5">Cron expression</label>
                <input
                  type="text"
                  value={form.cron_expr}
                  onChange={e => setForm(f => ({ ...f, cron_expr: e.target.value }))}
                  placeholder="0 9 * * 1"
                  className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-indigo-500/50"
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {PRESETS.map(p => (
                    <button
                      key={p.value}
                      onClick={() => setForm(f => ({ ...f, cron_expr: p.value }))}
                      className="px-2 py-0.5 text-xs bg-forge-bg border border-forge-border rounded hover:border-indigo-500/40 transition-colors"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-xs text-forge-muted hover:text-white transition-colors">Cancel</button>
                <button
                  onClick={createSchedule}
                  disabled={saving || !form.template_id || !form.cron_expr.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 btn-primary text-xs rounded-lg disabled:opacity-50"
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save schedule
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Schedule list */}
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-forge-muted" /></div>
        ) : schedules.length === 0 ? (
          <p className="text-sm text-forge-muted text-center py-8">No schedules yet. Create one above.</p>
        ) : (
          <div className="space-y-3">
            {schedules.map(s => (
              <div key={s.id} className="bg-forge-surface border border-forge-border rounded-xl p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{s.template_name}</p>
                    <p className="text-xs font-mono text-indigo-400 mt-0.5">{s.cron_expr}</p>
                    <p className="text-xs text-forge-muted mt-1">
                      Next run: {new Date(s.next_run_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => toggleSchedule(s.id, s.enabled)}
                      title={s.enabled ? 'Disable' : 'Enable'}
                      className={`p-1.5 rounded-lg transition-colors ${s.enabled ? 'text-emerald-400 hover:bg-emerald-500/10' : 'text-forge-muted hover:text-white'}`}
                    >
                      {s.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => deleteSchedule(s.id)}
                      className="p-1.5 rounded-lg text-forge-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
