import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getScaleOperationalState,
  resolveOperationalScale,
  scaleStartMs,
  type SharedContext,
  type SharedScale
} from './musicScaleBridge';

type Scope = 'auto' | 'all' | string;

function stateRank(state: ReturnType<typeof getScaleOperationalState>): number {
  return state === 'live' ? 0 : state === 'upcoming' ? 1 : state === 'recent' ? 2 : 3;
}

export function LiveContextSwitcher({
  context,
  scales,
  scope,
  now,
  compact = false,
  onScopeChange,
  onOpenScale
}: {
  context: SharedContext;
  scales: SharedScale[];
  scope: Scope;
  now: number;
  compact?: boolean;
  onScopeChange: (scope: Scope) => void;
  onOpenScale: (scale: SharedScale) => void;
}) {
  const { t } = useTranslation();

  const scopedScales = useMemo(
    () => scope === 'auto' || scope === 'all'
      ? scales
      : scales.filter(scale => scale.organizationId === scope),
    [scales, scope]
  );
  const operational = resolveOperationalScale(scopedScales, now);

  const visibleScales = useMemo(() => {
    const candidates = scales
      .filter(scale => getScaleOperationalState(scale, now) !== 'past')
      .sort((a, b) => {
        const stateDelta =
          stateRank(getScaleOperationalState(a, now)) -
          stateRank(getScaleOperationalState(b, now));
        return stateDelta || scaleStartMs(a) - scaleStartMs(b);
      });

    return candidates.slice(0, 8);
  }, [now, scales]);

  const renderState = (scale: SharedScale) => {
    const state = getScaleOperationalState(scale, now);
    return (
      <span className={`live-context-state state-${state}`}>
        {t(`liveContext.states.${state}`)}
      </span>
    );
  };

  return (
    <section className={`live-context-switcher ${compact ? 'compact' : ''}`}>
      <div className="live-context-primary">
        <div className="live-context-copy">
          <span className="eyebrow">{t('liveContext.kicker')}</span>
          <strong>
            {operational?.eventName || t('liveContext.noServiceTitle')}
          </strong>
          <small>
            {operational
              ? [
                  operational.organizationName,
                  operational.locationName,
                  operational.date,
                  operational.time
                ].filter(Boolean).join(' · ')
              : t('liveContext.noServiceDescription')}
          </small>
        </div>

        {operational && renderState(operational)}

        <label className="live-context-select">
          <span>{t('liveContext.view')}</span>
          <select
            value={scope}
            onChange={event => onScopeChange(event.target.value)}
          >
            <option value="auto">{t('liveContext.auto')}</option>
            <option value="all">{t('liveContext.all')}</option>
            {context.organizations.map(organization => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {scope === 'all' && !compact && (
        <div className="live-context-all">
          <div className="live-context-all-head">
            <strong>{t('liveContext.allTitle')}</strong>
            <span>{t('liveContext.allHint')}</span>
          </div>
          <div className="live-context-grid">
            {visibleScales.length ? visibleScales.map(scale => (
              <button
                type="button"
                key={scale.id}
                className={getScaleOperationalState(scale, now) === 'live' ? 'is-live' : ''}
                onClick={() => onOpenScale(scale)}
              >
                <span className="live-context-card-top">
                  <small>{scale.organizationName || t('organization')}</small>
                  {renderState(scale)}
                </span>
                <strong>{scale.eventName || t('liveContext.serviceFallback')}</strong>
                <span>
                  {[scale.locationName, scale.date, scale.time].filter(Boolean).join(' · ')}
                </span>
                <em>{t('liveContext.open')}</em>
              </button>
            )) : (
              <div className="live-context-empty">{t('liveContext.noServices')}</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
