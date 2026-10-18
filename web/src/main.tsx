import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PENDING_MAILTO_KEY, takeMailtoParam } from './mailto';
import './styles.css';

// Apply the system theme before the first render to avoid a flash.
document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

// Opened for a mailto: link (?mailto=…): keep the link for this tab, so it survives a sign-in
// round trip, and drop it from the URL so a reload doesn't open the composer again.
const opened = takeMailtoParam(window.location.search);
if (opened) {
  if (opened.mailto) sessionStorage.setItem(PENDING_MAILTO_KEY, opened.mailto);
  window.history.replaceState(window.history.state, '', window.location.pathname + opened.search + window.location.hash);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
