import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AudioChannel,
  AudioChannelProcessingState,
  AudioControlCommand,
  AudioSafetyLevel,
  MeterFrame,
  ScaleAudioContext
} from '@millionsnest/nestlive-domain';
import {
  NestLiveAudioApiClient,
  type AudioProviderSummary,
  type NestLiveNodeConnection
} from './audioNodeApiClient';
export type AudioConnectionStatus =
  | 'demo'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'error';

export function useNestLiveAudio(
  connection?: NestLiveNodeConnection
) {
  const [status, setStatus] = useState<AudioConnectionStatus>(
    connection ? 'connecting' : 'demo'
  );
  const [provider, setProvider] = useState<AudioProviderSummary>();
  const [channels, setChannels] = useState<AudioChannel[]>([]);
  const [frame, setFrame] = useState<MeterFrame>();
  const [error, setError] = useState<string>();
  const [network, setNetwork] = useState<
    Awaited<ReturnType<NestLiveAudioApiClient['inspectNetwork']>>
  >();
  const [scaleContext, setScaleContext] =
    useState<ScaleAudioContext>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [processingRevision, setProcessingRevision] = useState(0);

  const api = useMemo(
    () => (connection ? new NestLiveAudioApiClient(connection) : undefined),
    [connection]
  );

  useEffect(() => {
    if (!connection || !api) return;

    let alive = true;
    let disconnectMeter: (() => void) | undefined;
    let disconnectState: (() => void) | undefined;
    let networkTimer: number | undefined;
    setStatus('connecting');
    setError(undefined);

    void (async () => {
      try {
        const providers = await api.providers();
        if (!alive) return;

        const selected =
          providers.find(
            item =>
              item.providerInstanceId === connection.providerInstanceId
          ) ?? providers[0];

        if (!selected) {
          setProvider(undefined);
          setChannels([]);
          setStatus('online');
          return;
        }

        setProvider(selected);
        const nextChannels = await api.channels(selected.providerInstanceId);
        if (!alive) return;
        setChannels(nextChannels);

        const refreshSupplemental = async () => {
          const [networkResult, scaleResult] =
            await Promise.allSettled([
              api.inspectNetwork(),
              api.scaleAudioContext()
            ]);

          if (!alive) return;
          if (networkResult.status === 'fulfilled') {
            setNetwork(networkResult.value);
          }
          if (scaleResult.status === 'fulfilled') {
            setScaleContext(scaleResult.value);
          }
        };
        await refreshSupplemental();
        networkTimer = window.setInterval(() => {
          void refreshSupplemental();
        }, 5000);

        disconnectMeter = api.streamMeters(
          selected.providerInstanceId,
          {
            onFrame: incoming => {
              if (
                incoming.providerInstanceId ===
                selected.providerInstanceId
              ) {
                setFrame(incoming);
              }
            },
            onStatus: next => {
              if (alive) setStatus(next);
            }
          }
        );

        disconnectState = api.streamState(
          selected.providerInstanceId,
          {
            onPatch: patch => {
              if (!alive) return;

              if (
                patch.scope === 'channel' &&
                patch.targetId
              ) {
                setChannels(current =>
                  current.map(channel =>
                    channel.id === patch.targetId
                      ? { ...channel, ...patch.patch }
                      : channel
                  )
                );
                if (
                  patch.patch.processingDirty === true ||
                  'gainDb' in patch.patch ||
                  'phantom' in patch.patch
                ) {
                  setProcessingRevision(value => value + 1);
                }
                return;
              }

              if (
                patch.scope === 'console' &&
                Array.isArray(patch.patch.channels)
              ) {
                setChannels(
                  patch.patch.channels as AudioChannel[]
                );
              }
            }
          }
        );
      } catch (cause) {
        if (!alive) return;
        setStatus('error');
        setError(
          cause instanceof Error ? cause.message : 'audio_connection_failed'
        );
      }
    })();

    return () => {
      alive = false;
      disconnectMeter?.();
      disconnectState?.();
      if (networkTimer !== undefined) window.clearInterval(networkTimer);
    };
  }, [api, connection, refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey(value => value + 1);
  }, []);

  const execute = useCallback(
    async (
      command: AudioControlCommand,
      confirmedSafetyLevel?: AudioSafetyLevel
    ) => {
      if (!api || !provider) throw new Error('audio_not_connected');
      const execution = await api.execute({
        providerInstanceId: provider.providerInstanceId,
        actorId: 'live-operator',
        command,
        confirmedSafetyLevel
      });

      const targetId =
        'channelId' in command ? command.channelId : undefined;
      if (targetId && execution.result.observedState) {
        setChannels(current =>
          current.map(channel =>
            channel.id === targetId
              ? {
                  ...channel,
                  ...execution.result.observedState
                }
              : channel
          )
        );
      }
      if (
        command.type === 'setGain' ||
        command.type === 'setPhantom' ||
        command.type === 'setEq' ||
        command.type === 'setGate' ||
        command.type === 'setCompressor' ||
        command.type === 'loadScene'
      ) {
        setProcessingRevision(value => value + 1);
      }
      return execution;
    },
    [api, provider]
  );

  const assignScaleChannel = useCallback(
    async (input: {
      roleName: string;
      participantUserId?: string;
      channelId: string;
      enabled?: boolean;
    }) => {
      if (!api) throw new Error('audio_not_connected');
      const next = await api.assignScaleChannel(input);
      setScaleContext(next);
      return next;
    },
    [api]
  );

  const getProcessing = useCallback(
    async (channelId: string): Promise<AudioChannelProcessingState> => {
      if (!api || !provider) throw new Error('audio_not_connected');
      return api.channelProcessing(
        provider.providerInstanceId,
        channelId
      );
    },
    [api, provider]
  );

  return {
    api,
    status,
    provider,
    channels,
    frame,
    error,
    network,
    scaleContext,
    assignScaleChannel,
    execute,
    getProcessing,
    processingRevision,
    refresh,
    inspectNetwork: api ? () => api.inspectNetwork() : undefined,
    discoverX32: api ? () => api.discoverX32() : undefined,
    connectX32: api
      ? async (address: string) => {
          const result = await api.connectX32(address);
          refresh();
          return result;
        }
      : undefined
  };
}
