import { meterPercent, meterStatusText } from './uiModel';

export function MeterBar(props: {
  db: number;
  peakDb?: number;
  clip: boolean;
  available: boolean;
  stale?: boolean;
  compact?: boolean;
}) {
  const stale = props.stale ?? false;
  const status = meterStatusText({
    db: props.db,
    clip: props.clip,
    available: props.available,
    stale
  });

  return (
    <div
      className={`meter ${props.compact ? 'meter--compact' : ''}`}
      aria-label={`${status}, ${props.db.toFixed(1)} decibéis`}
    >
      <div className="meter__track" aria-hidden="true">
        <div
          className="meter__fill"
          data-state={status.toLowerCase().replaceAll(' ', '-')}
          style={{ inlineSize: `${meterPercent(props.db)}%` }}
        />
        {props.peakDb !== undefined && props.peakDb > -60 ? (
          <span
            className="meter__peak"
            style={{ insetInlineStart: `${meterPercent(props.peakDb)}%` }}
          />
        ) : null}
      </div>
      <div className="meter__meta">
        <span>{status}</span>
        <strong>{props.db <= -95 ? '−∞' : `${props.db.toFixed(1)} dB`}</strong>
      </div>
    </div>
  );
}
