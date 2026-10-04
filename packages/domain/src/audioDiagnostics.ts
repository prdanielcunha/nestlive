import type { AudioSafetyLevel, EntityId } from './audio';

export type AudioDiagnosticCode =
  | 'provider_offline'
  | 'telemetry_stale'
  | 'input_no_signal'
  | 'channel_muted'
  | 'group_muted'
  | 'fader_too_low'
  | 'gate_blocking'
  | 'compression_excessive'
  | 'main_unassigned'
  | 'bus_send_closed'
  | 'bus_master_closed'
  | 'clipping'
  | 'output_no_signal';

export type SignalTraceEvidence = 'observed' | 'inferred' | 'unknown';

export interface AudioDiagnosticInput {
  channelId: EntityId;
  channelName: string;
  providerOnline: boolean;
  telemetryStale: boolean;
  inputDb?: number;
  postFaderDb?: number;
  outputDb?: number;
  faderDb?: number;
  muted?: boolean;
  groupMuted?: boolean;
  gateOpen?: boolean;
  gainReductionDb?: number;
  assignedToMain?: boolean;
  busSendDb?: number;
  busMasterDb?: number;
  clip?: boolean;
}

export interface AudioDiagnosticFinding {
  code: AudioDiagnosticCode;
  channelId: EntityId;
  title: string;
  explanation: string;
  severity: 'info' | 'warning' | 'critical';
  evidence: SignalTraceEvidence;
  action?: {
    label: string;
    capability: string;
    safetyLevel: AudioSafetyLevel;
  };
}

export interface SignalTraceStep {
  id: string;
  label: string;
  status: 'ok' | 'blocked' | 'silent' | 'unknown';
  value?: string;
  evidence: SignalTraceEvidence;
}

function db(value: number | undefined): string | undefined {
  return value === undefined
    ? undefined
    : value <= -95
      ? '−∞'
      : `${value.toFixed(1)} dB`;
}

export function diagnoseAudio(
  input: AudioDiagnosticInput
): AudioDiagnosticFinding[] {
  const findings: AudioDiagnosticFinding[] = [];
  const add = (
    code: AudioDiagnosticCode,
    title: string,
    explanation: string,
    severity: AudioDiagnosticFinding['severity'],
    action?: AudioDiagnosticFinding['action'],
    evidence: SignalTraceEvidence = 'observed'
  ) => {
    findings.push({
      code,
      channelId: input.channelId,
      title,
      explanation,
      severity,
      evidence,
      action
    });
  };

  if (!input.providerOnline) {
    add(
      'provider_offline',
      `${input.channelName}: mesa desconectada`,
      'O NestLive não está recebendo estado da mesa. Reconecte a rede de áudio antes de alterar o canal.',
      'critical'
    );
    return findings;
  }

  if (input.telemetryStale) {
    add(
      'telemetry_stale',
      `${input.channelName}: telemetria congelada`,
      'O último meter é antigo; não tratamos isso como ausência de sinal.',
      'warning'
    );
  }

  if (
    input.inputDb !== undefined &&
    input.inputDb < -60 &&
    !input.telemetryStale
  ) {
    add(
      'input_no_signal',
      `${input.channelName}: sem sinal na entrada`,
      'A entrada está abaixo do limiar útil antes do fader.',
      'warning'
    );
  }

  if (input.muted) {
    add(
      'channel_muted',
      `${input.channelName}: canal mutado`,
      'Há sinal antes do mute, mas o canal está fechado.',
      'critical',
      {
        label: `Desmutar ${input.channelName}`,
        capability: 'audio.mute.write',
        safetyLevel: 'guarded'
      }
    );
  }

  if (input.groupMuted) {
    add(
      'group_muted',
      `${input.channelName}: grupo/DCA mutado`,
      'O canal pode estar aberto, porém um grupo acima dele está mutado.',
      'critical',
      undefined,
      'observed'
    );
  }

  if ((input.faderDb ?? 0) <= -60) {
    add(
      'fader_too_low',
      `${input.channelName}: fader muito baixo`,
      'O nível do fader pode impedir a saída mesmo com entrada presente.',
      'warning'
    );
  }

  if (input.gateOpen === false && (input.inputDb ?? -96) > -45) {
    add(
      'gate_blocking',
      `${input.channelName}: gate bloqueando passagem`,
      'Existe sinal relevante na entrada, mas o gate permanece fechado.',
      'warning'
    );
  }

  if ((input.gainReductionDb ?? 0) < -18) {
    add(
      'compression_excessive',
      `${input.channelName}: compressão excessiva`,
      'A redução de ganho está muito alta e pode tornar o canal inaudível ou instável.',
      'warning'
    );
  }

  if (input.assignedToMain === false) {
    add(
      'main_unassigned',
      `${input.channelName}: fora do Main LR`,
      'O canal não está atribuído ao destino principal.',
      'critical'
    );
  }

  if (input.busSendDb !== undefined && input.busSendDb <= -90) {
    add(
      'bus_send_closed',
      `${input.channelName}: envio para bus fechado`,
      'O send selecionado está em −∞.',
      'warning'
    );
  }

  if (input.busMasterDb !== undefined && input.busMasterDb <= -60) {
    add(
      'bus_master_closed',
      'Bus master muito baixo',
      'O canal envia ao bus, mas o master do bus está praticamente fechado.',
      'warning'
    );
  }

  if (input.clip || (input.inputDb ?? -96) >= 0) {
    add(
      'clipping',
      `${input.channelName}: clipping`,
      'O sinal alcançou ou ultrapassou 0 dBFS.',
      'critical'
    );
  }

  if (
    (input.postFaderDb ?? -96) > -45 &&
    (input.outputDb ?? -96) < -60 &&
    input.assignedToMain !== false
  ) {
    add(
      'output_no_signal',
      `${input.channelName}: sinal não chega à saída`,
      'Há sinal após o fader, mas a saída observada permanece silenciosa.',
      'warning',
      undefined,
      'inferred'
    );
  }

  return findings;
}

export function buildSignalTrace(
  input: AudioDiagnosticInput
): SignalTraceStep[] {
  const signal = (value: number | undefined) =>
    value !== undefined && value > -60;

  return [
    {
      id: 'input',
      label: 'INPUT',
      status:
        input.inputDb === undefined
          ? 'unknown'
          : signal(input.inputDb)
            ? 'ok'
            : 'silent',
      value: db(input.inputDb),
      evidence:
        input.inputDb === undefined ? 'unknown' : 'observed'
    },
    {
      id: 'gate',
      label: 'GATE',
      status:
        input.gateOpen === undefined
          ? 'unknown'
          : input.gateOpen
            ? 'ok'
            : 'blocked',
      value:
        input.gateOpen === undefined
          ? undefined
          : input.gateOpen
            ? 'aberto'
            : 'fechado',
      evidence:
        input.gateOpen === undefined ? 'unknown' : 'observed'
    },
    {
      id: 'compressor',
      label: 'COMP',
      status:
        input.gainReductionDb === undefined
          ? 'unknown'
          : input.gainReductionDb < -18
            ? 'blocked'
            : 'ok',
      value: db(input.gainReductionDb),
      evidence:
        input.gainReductionDb === undefined ? 'unknown' : 'observed'
    },
    {
      id: 'fader',
      label: 'FADER',
      status:
        input.faderDb === undefined
          ? 'unknown'
          : input.faderDb <= -60
            ? 'blocked'
            : 'ok',
      value: db(input.faderDb),
      evidence:
        input.faderDb === undefined ? 'unknown' : 'observed'
    },
    {
      id: 'mute',
      label: 'MUTE / DCA',
      status:
        input.muted === undefined && input.groupMuted === undefined
          ? 'unknown'
          : input.muted || input.groupMuted
            ? 'blocked'
            : 'ok',
      value:
        input.muted === undefined && input.groupMuted === undefined
          ? undefined
          : input.muted || input.groupMuted
            ? 'mutado'
            : 'aberto',
      evidence:
        input.muted === undefined && input.groupMuted === undefined
          ? 'unknown'
          : 'observed'
    },
    {
      id: 'main',
      label: 'MAIN LR',
      status:
        input.assignedToMain === false
          ? 'blocked'
          : input.outputDb === undefined
            ? 'unknown'
            : signal(input.outputDb)
              ? 'ok'
              : 'silent',
      value: db(input.outputDb),
      evidence:
        input.outputDb === undefined ? 'unknown' : 'observed'
    }
  ];
}
