import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RemoteMixApp } from './RemoteMixApp';
import { consumeNestLiveEcosystemHandoff } from './ecosystemHandoff';
import './styles.css';

function HandoffFailure(props: { message: string }) {
  return (
    <main className="remote-gate">
      <section className="remote-gate__card">
        <span className="eyebrow">NESTLIVE · MILLIONSNEST</span>
        <h1>Não foi possível validar o acesso</h1>
        <p>
          Volte ao MillionsNest Hub e abra o NestLive novamente.
        </p>
        <code>{props.message}</code>
      </section>
    </main>
  );
}

async function bootstrap() {
  let handoffError: string | undefined;
  try {
    await consumeNestLiveEcosystemHandoff();
  } catch (error) {
    handoffError =
      error instanceof Error
        ? error.message
        : 'ecosystem_handoff_failed';
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {handoffError ? (
        <HandoffFailure message={handoffError} />
      ) : window.location.pathname.startsWith('/remote') ? (
        <RemoteMixApp />
      ) : (
        <App />
      )}
    </StrictMode>
  );
}

void bootstrap();
