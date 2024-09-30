import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/source-serif-4/600.css';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, ORGS } from './api';
import { useUnreachable } from './components/states';
import { Admin } from './pages/Admin';
import { Doctor } from './pages/Doctor';
import { Login } from './pages/Login';
import { Patient } from './pages/Patient';
import { SessionProvider, useSession } from './session';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      // Policy denials and auth failures won't change on retry; outages might.
      retry: (n, err) => !(err instanceof ApiError && [400, 401, 403, 404, 409].includes(err.status)) && n < 1,
    },
  },
});

function App() {
  const { session, logout } = useSession();
  if (!session) return <Login />;
  const { user, org } = session;
  return <Shell org={org} user={user} onLogout={() => logout()} />;
}

function Shell({ org, user, onLogout }: { org: keyof typeof ORGS; user: { displayName: string; role: string }; onLogout: () => void }) {
  const unreachable = useUnreachable();
  return (
    <>
      <nav className="topbar" aria-label="Session">
        <div className="brand">
          <strong>Planetary Health</strong>
          <span className="muted small full">{ORGS[org].name}</span>
          <span className="muted small short">{ORGS[org].short}</span>
        </div>
        <div className="who">
          <span>
            {user.displayName} <span className="muted role-name">· {user.role}</span>
          </span>
          <button type="button" className="ghost" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </nav>
      {unreachable && (
        <p className="banner amber netbanner" role="status">
          Can’t reach the {ORGS[org].name} gateway. It may be waking up; data below may be missing until it answers.
        </p>
      )}
      <main className="shell">{user.role === 'patient' ? <Patient /> : user.role === 'doctor' ? <Doctor /> : <Admin />}</main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
