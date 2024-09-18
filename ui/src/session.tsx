import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { type OrgKey, request, setUnauthorizedHandler, type User } from './api';

interface Session {
  org: OrgKey;
  token: string;
  user: User;
  expiresAt: string;
}

interface SessionApi {
  session: Session | null;
  login: (org: OrgKey, username: string, password: string) => Promise<void>;
  logout: (reason?: string) => void;
  notice: string | null;
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
}

const Ctx = createContext<SessionApi | null>(null);
const KEY = 'ph.session';
// HIPAA §164.312(a)(2)(iii): automatic logoff after inactivity, independent of the 15-minute JWT.
const IDLE_MS = 10 * 60 * 1000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return new Date(s.expiresAt) > new Date() ? s : null;
  });
  const [notice, setNotice] = useState<string | null>(null);

  const logout = useCallback((reason?: string) => {
    sessionStorage.removeItem(KEY);
    setSession(null);
    setNotice(reason ?? null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => logout('Your session expired. Sign in again.'));
  }, [logout]);

  useEffect(() => {
    if (!session) return;
    let timer = window.setTimeout(() => logout('Signed out after 10 minutes without activity.'), IDLE_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => logout('Signed out after 10 minutes without activity.'), IDLE_MS);
    };
    const expiry = window.setTimeout(() => logout('Your session expired. Sign in again.'), new Date(session.expiresAt).getTime() - Date.now());
    for (const ev of ['keydown', 'pointerdown'] as const) window.addEventListener(ev, reset);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(expiry);
      for (const ev of ['keydown', 'pointerdown'] as const) window.removeEventListener(ev, reset);
    };
  }, [session, logout]);

  const login = useCallback(async (org: OrgKey, username: string, password: string) => {
    const r = await request<{ token: string; expiresAt: string; user: User }>(org, null, 'POST', '/auth/login', { username, password });
    const s = { org, token: r.token, user: r.user, expiresAt: r.expiresAt };
    sessionStorage.setItem(KEY, JSON.stringify(s));
    setNotice(null);
    setSession(s);
  }, []);

  const value = useMemo<SessionApi>(
    () => ({
      session,
      login,
      logout,
      notice,
      api: <T,>(method: string, path: string, body?: unknown) => {
        if (!session) return Promise.reject(new Error('not signed in'));
        return request<T>(session.org, session.token, method, path, body);
      },
    }),
    [session, login, logout, notice],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
