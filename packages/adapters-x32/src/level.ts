export function x32LevelToDb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  if (v <= 0) return -96;
  if (v <= 0.0625) return -90 + (v / 0.0625) * 30;
  if (v <= 0.25) return -60 + ((v - 0.0625) / 0.1875) * 30;
  if (v <= 0.5) return -30 + ((v - 0.25) / 0.25) * 20;
  return -10 + ((v - 0.5) / 0.5) * 20;
}

export function dbToX32Level(db: number): number {
  if (!Number.isFinite(db) || db <= -90) return 0;
  if (db <= -60) return ((db + 90) / 30) * 0.0625;
  if (db <= -30) return 0.0625 + ((db + 60) / 30) * 0.1875;
  if (db <= -10) return 0.25 + ((db + 30) / 20) * 0.25;
  return Math.max(0, Math.min(1, 0.5 + ((db + 10) / 20) * 0.5));
}

export function linearMeterToDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return -96;
  return Math.max(-96, 20 * Math.log10(value));
}
