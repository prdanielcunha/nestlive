import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n';
import './styles.css';

interface RootErrorBoundaryState {
  error: Error | null;
}

class RootErrorBoundary extends React.Component<
  React.PropsWithChildren,
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[NestLive] root runtime error', error);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="center" role="alert">
        <div className="boot-orb" />
        <h1 style={{ margin: '0 0 8px', fontSize: '24px' }}>NestLive</h1>
        <p style={{ maxWidth: '420px', textAlign: 'center' }}>
          Não foi possível iniciar o controle neste navegador. Recarregue a página.
          Se continuar, abra novamente pelo QR do Live Node.
        </p>
        <button className="primary" type="button" onClick={() => window.location.reload()}>
          Recarregar
        </button>
      </main>
    );
  }
}

function privateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }

  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
  );
}

function mayBeLocalNodeOrigin(): boolean {
  const host = window.location.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    privateIpv4(host)
  );
}

function BootFailure() {
  return (
    <main className="center" role="alert">
      <div className="boot-orb" />
      <h1 style={{ margin: '0 0 8px', fontSize: '24px' }}>NestLive</h1>
      <p style={{ maxWidth: '420px', textAlign: 'center' }}>
        Não foi possível carregar o controle local. Confirme a rede e tente novamente.
      </p>
      <button className="primary" type="button" onClick={() => window.location.reload()}>
        Tentar novamente
      </button>
    </main>
  );
}

async function mount(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('root_not_found');

  let RootComponent: React.ComponentType;

  if (mayBeLocalNodeOrigin()) {
    const { detectSameOriginLiveNode } = await import('./liveNodeClient');
    const isLocalNode = await detectSameOriginLiveNode();

    if (isLocalNode) {
      const { LocalNodeApp } = await import('./LocalNodeApp');
      RootComponent = LocalNodeApp;
    } else {
      const { App } = await import('./App');
      RootComponent = App;
    }
  } else {
    const { App } = await import('./App');
    RootComponent = App;
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <RootComponent />
      </RootErrorBoundary>
    </React.StrictMode>
  );
}

void mount().catch(error => {
  console.error('[NestLive] bootstrap failed', error);
  const root = document.getElementById('root');
  if (!root) return;
  ReactDOM.createRoot(root).render(<BootFailure />);
});
