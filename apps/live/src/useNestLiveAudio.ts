import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AudioChannel,
  AudioControlCommand,
  AudioSafetyLevel,
  MeterFrame
} from '@millionsnest/nestlive-domain';
import {
  NestLiveAudioApiClient,
  type AudioProviderSummary,
  type NestLiveNodeConnection
} from './audioNodeApiClient';
import { NestLiveNodeMeterClient } from './nodeClient';

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
  const [refreshKey, setRefreshKey] = useState(0);

  const api = useMemo(
    () => (connection ? new NestLiveAudioApiClient(connection) : undefined),
    [connection]
  );

  useEffect(() => {
    if (!connection || !api) return;

    let alive = true;
    let disconnectMeter: (() => void) | undefined;
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

        const meterClient = new NestLiveNodeMeterClient();
        disconnectMeter = meterClient.connect({
          url: connection.wsUrl,
          token: connection.token,
          onFrame: incoming => {
            if (
              incoming.providerInstanceId === selected.providerInstanceId
            ) {
              setFrame(incoming);
            }
          },
          onStatus: next => {
            if (alive) setStatus(next);
          }
        });
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
      return execution;
    },
    [api, provider]
  );

  return {
    status,
    provider,
    channels,
    frame,
    error,
    execute,
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
