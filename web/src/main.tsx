import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './index.css';
import { App } from './App.tsx';
import { ToastProvider } from './ui/toast.tsx';
import { loadRuntimeConfig } from './lib/api.ts';

// Runtime config (/config.json) tells a statically hosted build where the API is; no-op self-hosted.
void loadRuntimeConfig().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </StrictMode>,
  ),
);
