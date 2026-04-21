import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';

interface User {
  id: string;
  email: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Wrapper around fetch() that injects the Authorization header. */
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function decodeUser(accessToken: string): User {
  const payload = JSON.parse(atob(accessToken.split('.')[1]));
  return { id: payload.user_id as string, email: payload.email as string };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const accessTokenRef = useRef<string | null>(null);
  const refreshTokenRef = useRef<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem('refresh_token') : null,
  );

  // Persist a fully resolved session.
  const applyTokens = useCallback((accessToken: string, refreshToken: string) => {
    accessTokenRef.current = accessToken;
    refreshTokenRef.current = refreshToken;
    localStorage.setItem('refresh_token', refreshToken);
    setUser(decodeUser(accessToken));
  }, []);

  // Try to restore session from persisted refresh token on mount.
  useEffect(() => {
    const rt = refreshTokenRef.current;
    if (!rt) {
      setLoading(false);
      return;
    }
    fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    })
      .then(res => (res.ok ? res.json() : Promise.reject()))
      .then(data => applyTokens(data.access_token, data.refresh_token))
      .catch(() => {
        refreshTokenRef.current = null;
        localStorage.removeItem('refresh_token');
      })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Schedule automatic token refresh 60 s before expiry.
  useEffect(() => {
    if (!user) return;
    const at = accessTokenRef.current;
    if (!at) return;
    const payload = JSON.parse(atob(at.split('.')[1]));
    const expiresAt = (payload.exp as number) * 1000;
    const delay = expiresAt - Date.now() - 60_000;
    if (delay <= 0) return;
    const timer = setTimeout(async () => {
      const rt = refreshTokenRef.current;
      if (!rt) return;
      try {
        const res = await fetch('/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt }),
        });
        if (res.ok) {
          const data = await res.json();
          applyTokens(data.access_token, data.refresh_token);
        }
      } catch { /* ignore */ }
    }, delay);
    return () => clearTimeout(timer);
  }, [user, applyTokens]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? 'Login failed');
    }
    const data = await res.json() as { access_token: string; refresh_token: string };
    applyTokens(data.access_token, data.refresh_token);
  }, [applyTokens]);

  const register = useCallback(async (email: string, password: string) => {
    const res = await fetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? 'Registration failed');
    }
    await login(email, password);
  }, [login]);

  const logout = useCallback(async () => {
    const rt = refreshTokenRef.current;
    if (rt) {
      await fetch('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      }).catch(() => { /* best-effort */ });
    }
    accessTokenRef.current = null;
    refreshTokenRef.current = null;
    localStorage.removeItem('refresh_token');
    setUser(null);
  }, []);

  const authFetch = useCallback(
    (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      const at = accessTokenRef.current;
      if (at) headers.set('Authorization', `Bearer ${at}`);
      return fetch(input, { ...init, headers });
    },
    [],
  );

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, authFetch }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
