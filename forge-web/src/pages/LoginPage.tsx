import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Hammer } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/app', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-forge-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="relative">
            <div className="p-2 bg-forge-surface border border-forge-border rounded-lg">
              <Hammer className="w-5 h-5 text-forge-text" />
            </div>
          </div>
          <span className="font-bold text-lg tracking-tight text-forge-text">
            Forge
          </span>
        </div>

        <div className="bg-forge-surface border border-forge-border rounded-xl p-6">
          <h1 className="text-lg font-semibold mb-6">Sign in</h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-forge-muted mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-forge-border-bright transition-colors"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="block text-xs text-forge-muted mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-forge-border-bright transition-colors"
                placeholder="••••••••"
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full btn-primary py-2 text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <p className="text-xs text-forge-muted text-center mt-4">
            Don&apos;t have an account?{' '}
            <Link to="/register" className="text-forge-text hover:text-white transition-colors underline underline-offset-2">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
