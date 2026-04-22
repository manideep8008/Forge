import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Users, Plus, ArrowLeft, Loader2, UserPlus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { Workspace, WorkspaceDetail } from '../types/collaboration';

export default function WorkspacesPage() {
  const { authFetch, user } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<WorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState('');

  const fetchWorkspaces = useCallback(async () => {
    try {
      const res = await authFetch('/api/workspaces');
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(data.workspaces ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { void fetchWorkspaces(); }, [fetchWorkspaces]);

  const openWorkspace = useCallback(async (id: string) => {
    const res = await authFetch(`/api/workspaces/${id}`);
    if (res.ok) setSelected(await res.json());
  }, [authFetch]);

  const createWorkspace = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError('');
    const res = await authFetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (res.ok) {
      setNewName('');
      await fetchWorkspaces();
    } else {
      setError('Failed to create workspace');
    }
    setCreating(false);
  };

  const invite = async () => {
    if (!selected || !inviteEmail.trim()) return;
    setInviting(true);
    const res = await authFetch(`/api/workspaces/${selected.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail.trim() }),
    });
    if (res.ok) {
      setInviteEmail('');
      await openWorkspace(selected.id);
    }
    setInviting(false);
  };

  return (
    <div className="min-h-screen bg-forge-bg p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link to="/" className="text-forge-muted hover:text-white transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <Users className="w-5 h-5 text-indigo-400" />
          <h1 className="text-lg font-semibold">Workspaces</h1>
        </div>

        {selected ? (
          /* ── Workspace detail ── */
          <div className="bg-forge-surface border border-forge-border rounded-xl p-5">
            <button
              onClick={() => setSelected(null)}
              className="flex items-center gap-1.5 text-xs text-forge-muted hover:text-white mb-4 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
            <h2 className="font-semibold text-base mb-1">{selected.name}</h2>
            <p className="text-xs text-forge-muted mb-4">{selected.members.length} member{selected.members.length !== 1 ? 's' : ''}</p>

            {/* Members list */}
            <div className="space-y-2 mb-5">
              {selected.members.map(m => (
                <div key={m.id} className="flex items-center justify-between bg-forge-bg border border-forge-border rounded-lg px-3 py-2">
                  <span className="text-sm">{m.email}</span>
                  <span className="text-xs text-forge-muted capitalize">{m.role}</span>
                </div>
              ))}
            </div>

            {/* Invite member (owner only) */}
            {selected.owner_id === user?.id && (
              <div className="flex gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="Invite by email"
                  className="flex-1 bg-forge-bg border border-forge-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500/50"
                />
                <button
                  onClick={invite}
                  disabled={inviting}
                  className="flex items-center gap-1.5 px-3 py-1.5 btn-primary text-xs rounded-lg disabled:opacity-50"
                >
                  {inviting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                  Invite
                </button>
              </div>
            )}
          </div>
        ) : (
          /* ── Workspace list ── */
          <>
            {/* Create workspace */}
            <div className="bg-forge-surface border border-forge-border rounded-xl p-5 mb-4">
              <h2 className="text-sm font-medium mb-3">New workspace</h2>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createWorkspace()}
                  placeholder="Workspace name"
                  className="flex-1 bg-forge-bg border border-forge-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500/50"
                />
                <button
                  onClick={createWorkspace}
                  disabled={creating || !newName.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 btn-primary text-xs rounded-lg disabled:opacity-50"
                >
                  {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Create
                </button>
              </div>
              {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
            </div>

            {/* List */}
            {loading ? (
              <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-forge-muted" /></div>
            ) : workspaces.length === 0 ? (
              <p className="text-sm text-forge-muted text-center py-8">No workspaces yet. Create one above.</p>
            ) : (
              <div className="space-y-2">
                {workspaces.map(ws => (
                  <button
                    key={ws.id}
                    onClick={() => openWorkspace(ws.id)}
                    className="w-full flex items-center justify-between bg-forge-surface border border-forge-border rounded-xl px-4 py-3 hover:border-indigo-500/40 transition-colors text-left"
                  >
                    <div>
                      <p className="text-sm font-medium">{ws.name}</p>
                      <p className="text-xs text-forge-muted capitalize">{ws.role}</p>
                    </div>
                    <ArrowLeft className="w-3.5 h-3.5 text-forge-muted rotate-180" />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
