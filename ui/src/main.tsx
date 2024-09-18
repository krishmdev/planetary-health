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
  return (
    <>
      <nav className="topbar" aria-label="Session">
        <div className="brand">
          <strong>Planetary Health</strong>
          <span className="muted small">{ORGS[org].name}</span>
        </div>
        <div className="who">
          <span>
            {user.displayName} <span className="muted role-name">· {user.role}</span>
          </span>
          <button type="button" className="ghost" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </nav>
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
