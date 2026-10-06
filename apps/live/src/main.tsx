import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RemoteMixApp } from './RemoteMixApp';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname.startsWith('/remote') ? (
      <RemoteMixApp />
    ) : (
      <App />
    )}
  </StrictMode>
);
