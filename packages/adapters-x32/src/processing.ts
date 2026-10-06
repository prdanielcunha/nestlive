const RATIO_VALUES = [
  1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20, 100
] as const;

function assertFiniteRange(
  value: number,
  min: number,
  max: number,
  label: string
): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`x32_${label}_out_of_range:${value}`);
  }
  return value;
}

export function linearToNormalized(
  min: number,
  max: number,
  value: number,
  label = 'value'
): number {
  assertFiniteRange(value, min, max, label);
  return (value - min) / (max - min);
}

export function normalizedToLinear(
  min: number,
  max: number,
  value: number
): number {
  const normalized = Math.max(0, Math.min(1, value));
  return min + (max - min) * normalized;
}

export function logToNormalized(
  min: number,
  max: number,
  value: number,
  label = 'value'
): number {
  assertFiniteRange(value, min, max, label);
  return Math.log(value / min) / Math.log(max / min);
}

export function normalizedToLog(
  min: number,
  max: number,
  value: number
): number {
  const normalized = Math.max(0, Math.min(1, value));
  return min * Math.exp(Math.log(max / min) * normalized);
}

export function qToNormalized(q: number): number {
  return 1 - logToNormalized(0.3, 10, q, 'eq_q');
}

export function normalizedToQ(value: number): number {
  return normalizedToLog(0.3, 10, 1 - Math.max(0, Math.min(1, value)));
}

export function ratioToIndex(ratio: number): number {
  const index = RATIO_VALUES.findIndex(value => Math.abs(value - ratio) < 0.001);
  if (index < 0) {
    throw new Error(
      `x32_compressor_ratio_unsupported:${ratio};expected=${RATIO_VALUES.join(',')}`
    );
  }
  return index;
}

export function indexToRatio(index: number): number {
  const value = RATIO_VALUES[index];
  if (value === undefined) throw new Error(`x32_compressor_ratio_index_invalid:${index}`);
  return value;
}

/**
 * /ch/NN/config/source uses the X32 source number space:
 * 1..32 Local, 33..80 AES50-A, 81..128 AES50-B.
 * Those three ranges map directly to flat headamp indexes 000..127.
 * Card/Aux/off sources do not expose a controllable physical headamp.
 */
export function resolveX32HeadampIndex(
  sourceIndex: number
): number | undefined {
  if (!Number.isInteger(sourceIndex)) return undefined;
  if (sourceIndex >= 1 && sourceIndex <= 128) return sourceIndex - 1;
  return undefined;
}

export function headampGainToNormalized(db: number): number {
  return linearToNormalized(-12, 60, db, 'headamp_gain');
}

export function normalizedToHeadampGain(value: number): number {
  return normalizedToLinear(-12, 60, value);
}

export const X32_PROCESSING_RANGES = {
  eq: {
    frequencyHz: [20, 20000] as const,
    gainDb: [-15, 15] as const,
    q: [0.3, 10] as const
  },
  gate: {
    thresholdDb: [-80, 0] as const,
    rangeDb: [3, 60] as const,
    attackMs: [0, 120] as const,
    holdMs: [0.02, 2000] as const,
    releaseMs: [5, 4000] as const
  },
  compressor: {
    thresholdDb: [-60, 0] as const,
    knee: [0, 5] as const,
    makeupGainDb: [0, 24] as const,
    attackMs: [0, 120] as const,
    holdMs: [0.02, 2000] as const,
    releaseMs: [5, 4000] as const,
    mixPercent: [0, 100] as const
  }
} as const;
