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

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  try {
    const payloadSegment = accessToken.split('.')[1];
    if (!payloadSegment) return null;
    const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeUser(accessToken: string): User | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload || typeof payload.user_id !== 'string' || typeof payload.email !== 'string') {
    return null;
  }
  return { id: payload.user_id, email: payload.email };
}

function clearLegacyRefreshToken(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('refresh_token');
    }
  } catch {
    // Ignore storage cleanup failures; refresh tokens are no longer read from JS.
  }
}

let accessTokenRefreshPromise: Promise<string | null> | null = null;

function requestAccessTokenRefresh(): Promise<string | null> {
  if (!accessTokenRefreshPromise) {
    accessTokenRefreshPromise = fetch('/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json() as { access_token?: unknown };
        return typeof data.access_token === 'string' ? data.access_token : null;
      })
      .catch(() => null)
      .finally(() => {
        accessTokenRefreshPromise = null;
      });
  }

  return accessTokenRefreshPromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const accessTokenRef = useRef<string | null>(null);

  // Apply the short-lived access token; the refresh token stays in an HttpOnly cookie.
  const applyAccessToken = useCallback((accessToken: string) => {
    clearLegacyRefreshToken();
    const decodedUser = decodeUser(accessToken);
    if (!decodedUser) {
      accessTokenRef.current = null;
      setUser(null);
      return false;
    }
    accessTokenRef.current = accessToken;
    setUser(decodedUser);
    return true;
  }, []);

  const refreshAndApplyAccessToken = useCallback(async () => {
    const accessToken = await requestAccessTokenRefresh();
    if (!accessToken) return null;
    return applyAccessToken(accessToken) ? accessToken : null;
  }, [applyAccessToken]);

  // Try to restore session from the HttpOnly refresh-token cookie on mount.
  useEffect(() => {
    let active = true;
    clearLegacyRefreshToken();
    requestAccessTokenRefresh()
      .then((accessToken) => {
        if (!active) return;
        if (!accessToken || !applyAccessToken(accessToken)) {
          accessTokenRef.current = null;
          setUser(null);
        }
      })
      .catch(() => {
        if (!active) return;
        accessTokenRef.current = null;
        setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [applyAccessToken]);

  // Schedule automatic token refresh 60 s before expiry.
  useEffect(() => {
    if (!user) return;
    const at = accessTokenRef.current;
    if (!at) return;
    const payload = decodeJwtPayload(at);
    if (typeof payload?.exp !== 'number') {
      accessTokenRef.current = null;
      setUser(null);
      return;
    }
    const expiresAt = payload.exp * 1000;
    const delay = expiresAt - Date.now() - 60_000;
    let active = true;
    const refresh = async () => {
      const accessToken = await requestAccessTokenRefresh();
      if (!active || !accessToken) return;
      applyAccessToken(accessToken);
    };

    if (delay <= 0) {
      void refresh();
      return () => {
        active = false;
      };
    }

    const timer = setTimeout(async () => {
      await refresh();
    }, delay);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [user, applyAccessToken]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? 'Login failed');
    }
    const data = await res.json() as { access_token: string };
    if (!applyAccessToken(data.access_token)) {
      throw new Error('Invalid access token received');
    }
  }, [applyAccessToken]);

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
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
    }).catch(() => { /* best-effort */ });
    accessTokenRef.current = null;
    clearLegacyRefreshToken();
    setUser(null);
  }, []);

  const authFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const fetchWithAccessToken = (accessToken: string | null) => {
        const headers = new Headers(init.headers);
        if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
        return fetch(input, { ...init, headers });
      };

      const res = await fetchWithAccessToken(accessTokenRef.current);
      if (res.status !== 401) return res;

      const refreshedAccessToken = await refreshAndApplyAccessToken();
      if (!refreshedAccessToken) {
        accessTokenRef.current = null;
        setUser(null);
        return res;
      }

      return fetchWithAccessToken(refreshedAccessToken);
    },
    [refreshAndApplyAccessToken],
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
