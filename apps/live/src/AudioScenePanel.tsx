import { useState } from 'react';
import type { AudioControlCommand } from '@millionsnest/nestlive-domain';

export function AudioScenePanel(props: {
  enabled: boolean;
  onCommand?: (
    command: AudioControlCommand,
    safety?: 'normal' | 'guarded' | 'critical'
  ) => Promise<unknown>;
}) {
  const [scene, setScene] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();

  if (!props.enabled) {
    return (
      <section className="scene-panel scene-panel--locked">
        <span className="eyebrow">CENAS DE ÁUDIO</span>
        <h1>Recall protegido</h1>
        <p>
          Esta função permanece escondida da operação até a console concluir
          o gate físico de scene recall.
        </p>
      </section>
    );
  }

  const recall = async () => {
    if (!props.onCommand) return;
    setBusy(true);
    setResult(undefined);
    try {
      const response = await props.onCommand(
        { type: 'loadScene', sceneId: `scene-${scene}` },
        'critical'
      ) as {
        result?: {
          accepted?: boolean;
          observedState?: Record<string, unknown>;
        };
      };
      const accepted = response?.result?.accepted !== false;
      setResult(
        accepted
          ? `Cena ${scene} confirmada pela mesa.`
          : `A mesa não confirmou a cena ${scene}.`
      );
    } catch (error) {
      setResult(
        error instanceof Error ? error.message : 'scene_recall_failed'
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <section className="scene-panel">
      <header className="section-heading">
        <div>
          <span className="eyebrow">CENAS DE ÁUDIO</span>
          <h1>Recall protegido</h1>
        </div>
        <span className="pill pill--danger">ação crítica</span>
      </header>

      <div className="scene-panel__card">
        <div>
          <strong>Cena da X32</strong>
          <p>
            O NestLive só considera a ação concluída quando o índice observado
            pela mesa confirma o recall.
          </p>
        </div>
        <label>
          <span>Cena</span>
          <input
            type="number"
            min="1"
            max="100"
            value={scene}
            disabled={busy}
            onChange={event =>
              setScene(
                Math.max(1, Math.min(100, Number(event.target.value)))
              )
            }
          />
        </label>

        {!confirming ? (
          <button
            type="button"
            className="is-critical"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Preparar recall
          </button>
        ) : (
          <div className="scene-confirm">
            <strong>Recuperar a cena {scene} agora?</strong>
            <p>
              Isso pode alterar níveis, mutes, processamento e roteamento da
              console. Confirme apenas durante uma janela segura.
            </p>
            <div>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className="is-critical"
                disabled={busy}
                onClick={() => void recall()}
              >
                {busy ? 'Confirmando…' : 'Confirmar recall'}
              </button>
            </div>
          </div>
        )}

        {result ? <div className="scene-result">{result}</div> : null}
      </div>
    </section>
  );
}
