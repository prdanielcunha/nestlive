import { useEffect, useMemo, useState } from 'react';
import type { ResolvedScaleChannel } from '@millionsnest/nestlive-domain';
import type { MixChannelViewModel } from './uiModel';
import { MeterBar } from './MeterBar';

type ChannelState = 'pending' | 'testing' | 'checked' | 'attention';

interface SoundcheckState {
  state: ChannelState;
  peakDb?: number;
  clipCount: number;
}

export function SoundcheckView(props: {
  channels: MixChannelViewModel[];
  stale: boolean;
  scaleContext?: ResolvedScaleChannel[];
}) {
  const [stateByChannel, setStateByChannel] = useState<
    Record<string, SoundcheckState>
  >({});

  const scaleByChannel = useMemo(
    () =>
      new Map(
        (props.scaleContext ?? []).map(item => [item.channelId, item])
      ),
    [props.scaleContext]
  );

  useEffect(() => {
    setStateByChannel(current => {
      const next = { ...current };

      for (const channel of props.channels) {
        const previous = next[channel.id] ?? {
          state: 'pending' as const,
          clipCount: 0
        };
        const peakDb =
          previous.peakDb === undefined
            ? channel.peakDb
            : Math.max(previous.peakDb, channel.peakDb);
        const clippedNow = channel.clip && previous.peakDb !== channel.peakDb;

        next[channel.id] = {
          ...previous,
          peakDb,
          clipCount:
            previous.clipCount + (clippedNow ? 1 : 0),
          state:
            channel.clip && previous.state === 'checked'
              ? 'attention'
              : previous.state
        };
      }

      for (const id of Object.keys(next)) {
        if (!props.channels.some(channel => channel.id === id)) {
          delete next[id];
        }
      }
      return next;
    });
  }, [props.channels]);

  const setChannelState = (
    channelId: string,
    state: ChannelState
  ) => {
    setStateByChannel(current => ({
      ...current,
      [channelId]: {
        ...(current[channelId] ?? { clipCount: 0 }),
        state
      }
    }));
  };

  const checked = props.channels.filter(
    channel => stateByChannel[channel.id]?.state === 'checked'
  ).length;

  return (
    <section className="soundcheck">
      <header className="section-heading">
        <div>
          <span className="eyebrow">SOUNDCHECK</span>
          <h1>Passagem de som</h1>
        </div>
        <span className="pill">
          {checked}/{props.channels.length} checados
        </span>
      </header>

      <div className="soundcheck__list">
        {props.channels.map(channel => {
          const scale = scaleByChannel.get(channel.id);
          const item = stateByChannel[channel.id] ?? {
            state: 'pending' as const,
            clipCount: 0
          };
          const label =
            item.state === 'checked'
              ? 'checado'
              : item.state === 'testing'
                ? 'testando'
                : item.state === 'attention'
                  ? 'revisar'
                  : 'pendente';

          return (
            <article
              className="soundcheck-row"
              key={channel.id}
              data-state={item.state}
            >
              <span
                className="soundcheck-row__state"
                aria-label={label}
              >
                {item.state === 'checked'
                  ? '✓'
                  : item.state === 'testing'
                    ? '●'
                    : item.state === 'attention'
                      ? '!'
                      : '○'}
              </span>

              <div className="soundcheck-row__title">
                <strong>{scale?.roleName ?? channel.name}</strong>
                <small>
                  {scale?.participant?.displayName
                    ? `${scale.participant.displayName} · `
                    : ''}
                  {label}
                  {item.peakDb !== undefined
                    ? ` · pico ${item.peakDb.toFixed(1)} dB`
                    : ''}
                  {item.clipCount > 0
                    ? ` · ${item.clipCount} clip(s)`
                    : ''}
                </small>
              </div>

              <MeterBar
                compact
                db={channel.meterDb}
                peakDb={channel.peakDb}
                clip={channel.clip}
                available={channel.meterAvailable}
                stale={props.stale}
              />

              <div className="soundcheck-row__actions">
                {item.state !== 'testing' ? (
                  <button
                    type="button"
                    onClick={() =>
                      setChannelState(channel.id, 'testing')
                    }
                  >
                    Testar
                  </button>
                ) : null}
                {item.state !== 'checked' ? (
                  <button
                    type="button"
                    className="is-primary"
                    onClick={() =>
                      setChannelState(channel.id, 'checked')
                    }
                  >
                    Concluir
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      setChannelState(channel.id, 'testing')
                    }
                  >
                    Refazer
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <p className="soundcheck__guardrail">
        Trocar a pessoa escalada atualiza apenas o contexto. NestLive não altera
        ganho nem roteamento automaticamente.
      </p>
    </section>
  );
}
