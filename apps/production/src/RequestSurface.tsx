import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RequestKind } from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import {
  bibleRequestFromResults,
  type PreparedBibleRequest
} from './requestBible';
import { TeamChatPanel } from './TeamChatPanel';
import {
  sectionPresentationContext,
  type PreparedSectionCandidate
} from './requestSection';

type Controller = ReturnType<typeof useLiveNode>;

const PASTOR_KINDS: RequestKind[] = ['bible', 'song', 'message', 'media'];
const CONDUCTOR_KINDS: RequestKind[] = ['section', 'message'];

export function RequestSurface({
  controller,
  actorId,
  liveSessionId,
  mode
}: {
  controller: Controller;
  actorId: string;
  liveSessionId: string;
  mode: 'pastor' | 'conductor';
}) {
  const { t } = useTranslation();
  const kinds = mode === 'pastor' ? PASTOR_KINDS : CONDUCTOR_KINDS;
  const [kind, setKind] = useState<RequestKind>(kinds[0]!);
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [checkingBible, setCheckingBible] = useState(false);
  const [biblePreview, setBiblePreview] = useState<(PreparedBibleRequest & { query: string }) | null>(null);
  const [bibleError, setBibleError] = useState<string | null>(null);
  const [sendingQuick, setSendingQuick] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal');

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      await controller.refreshState().catch(() => null);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1400);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [controller.refreshState]);

  const bibleSearchProviders = useMemo(
    () => (controller.nodeState?.providers || []).filter(provider =>
      (provider.health === 'online' || provider.health === 'degraded') &&
      provider.capabilities.includes('bible.search') &&
      provider.capabilities.includes('bible.present')
    ),
    [controller.nodeState]
  );

  const bibleSearchProvider = useMemo(() => {
    if (mode !== 'pastor') return null;
    const routed = controller.nodeState?.routing?.bible;
    if (routed) {
      return bibleSearchProviders.find(provider => provider.providerId === routed) || null;
    }
    return bibleSearchProviders.length === 1 ? bibleSearchProviders[0]! : null;
  }, [bibleSearchProviders, controller.nodeState?.routing?.bible, mode]);

  const bibleRouteRequired =
    mode === 'pastor' &&
    !controller.nodeState?.routing?.bible &&
    bibleSearchProviders.length > 1;

  const conductorContext = useMemo(() => {
    if (mode !== 'conductor') return null;
    const providers = controller.nodeState?.providers || [];
    const contexts = providers
      .filter(provider =>
        provider.health === 'online' || provider.health === 'degraded'
      )
      .map(provider => {
        const presentation = provider.observed?.currentPresentation;
        if (!presentation || typeof presentation !== 'object') return null;
        return sectionPresentationContext(
          presentation as Record<string, unknown>,
          provider.providerId,
          provider.displayName || provider.providerKey || 'provider'
        );
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));

    const routedId = controller.nodeState?.routing?.presentation;
    if (routedId) {
      return contexts.find(context => context.providerId === routedId) || contexts[0] || null;
    }
    return contexts[0] || null;
  }, [controller.nodeState, mode]);

  useEffect(() => {
    setBiblePreview(null);
    setBibleError(null);
  }, [kind, value]);

  const ownRequests = useMemo(
    () => (controller.nodeState?.state.requests || [])
      .filter(request =>
        request.liveSessionId === liveSessionId &&
        request.actorId === actorId
      )
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8),
    [actorId, controller.nodeState, liveSessionId]
  );

  async function submitPayload(
    requestKind: RequestKind,
    payload: Record<string, unknown>
  ) {
    await controller.submitRequest({
      liveSessionId,
      actorId,
      kind: requestKind,
      payload: {
        ...payload,
        sourceSurface: mode
      },
      priority
    });
  }

  async function checkBibleReference() {
    const query = value.trim();
    if (!query || checkingBible || !bibleSearchProvider) return;
    setCheckingBible(true);
    setBibleError(null);
    setBiblePreview(null);
    try {
      const results = await controller.executeCommand({
        capability: 'bible.search',
        payload: { text: query },
        liveSessionId,
        actorId,
        targetProviderIds: [bibleSearchProvider.providerId],
        safetyLevel: 'normal'
      });
      const failed = results.find(result => !result.accepted);
      if (failed) throw new Error(failed.errorCode || 'provider_error');

      const prepared = bibleRequestFromResults(results, query);
      if (!prepared.ids.length) {
        throw new Error('bible_reference_not_found');
      }
      setBiblePreview({
        ...prepared,
        providerId: prepared.providerId || bibleSearchProvider.providerId,
        query
      });
    } catch (error) {
      setBibleError(error instanceof Error ? error.message : 'bible_reference_check_failed');
    } finally {
      setCheckingBible(false);
    }
  }

  async function submitCheckedBible() {
    if (!biblePreview || sending) return;
    setSending(true);
    setSent(false);
    try {
      await submitPayload('bible', {
        reference: biblePreview.reference,
        ids: biblePreview.ids,
        providerId: biblePreview.providerId,
        exact: true
      });
      setValue('');
      setBiblePreview(null);
      setSent(true);
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    setSent(false);
    try {
      const payload =
        kind === 'bible' ? { reference: text } :
        kind === 'song' ? { query: text } :
        kind === 'section' ? { section: text } :
        kind === 'media' ? { query: text } :
        { text };

      await submitPayload(kind, payload);
      setValue('');
      setSent(true);
    } finally {
      setSending(false);
    }
  }

  async function requestSectionNow(section: PreparedSectionCandidate) {
    if (!conductorContext || sendingQuick) return;
    setSendingQuick(section.id);
    setSent(false);
    try {
      await submitPayload('section', {
        section: section.label,
        providerId: conductorContext.providerId,
        presentationId: conductorContext.presentationId,
        songId: conductorContext.songId,
        index: section.index,
        exact: true
      });
      setSent(true);
    } finally {
      setSendingQuick(null);
    }
  }

  async function cancelRequest(requestId: string) {
    if (cancellingId) return;
    setCancellingId(requestId);
    try {
      await controller.updateRequestStatus(requestId, 'rejected', actorId);
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <section className="request-surface">
      <div className="request-surface-head">
        <div>
          <span className="eyebrow">{t(`requestsSurface.${mode}.kicker`)}</span>
          <h2>{t(`requestsSurface.${mode}.title`)}</h2>
          <p>{t(`requestsSurface.${mode}.description`)}</p>
        </div>
        <div className="request-safe-pill">
          <span />
          <strong>{t('requestsSurface.safeFlow')}</strong>
          <small>{t('requestsSurface.safeFlowHint')}</small>
        </div>
      </div>

      <div className="request-flow-rail" aria-label={t('requestsSurface.flowLabel')}>
        <span><b>1</b><small>{t('requestsSurface.flowSteps.request')}</small></span>
        <i />
        <span><b>2</b><small>{t('requestsSurface.flowSteps.prepare')}</small></span>
        <i />
        <span><b>3</b><small>{t('requestsSurface.flowSteps.execute')}</small></span>
      </div>

      {mode === 'conductor' && conductorContext && (
        <section className="conductor-live-context">
          <header>
            <div>
              <span>{t('requestsSurface.conductorContext.kicker')}</span>
              <strong>
                {conductorContext.title || t('requestsSurface.conductorContext.songFallback')}
              </strong>
              <small>
                {t('requestsSurface.conductorContext.provider', {
                  provider: conductorContext.providerName
                })}
              </small>
            </div>
            <em>{t('requestsSurface.conductorContext.safe')}</em>
          </header>

          <div className="conductor-section-rail">
            {conductorContext.sections.map(section => {
              const current = conductorContext.currentSectionId === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={current ? 'current' : ''}
                  disabled={Boolean(sendingQuick)}
                  onClick={() => void requestSectionNow(section)}
                >
                  <small>{current
                    ? t('requestsSurface.conductorContext.now')
                    : t('requestsSurface.conductorContext.request')}</small>
                  <strong>{section.label}</strong>
                  <span>{section.excerpt || t('requestsSurface.conductorContext.sectionReady')}</span>
                  <em>
                    {sendingQuick === section.id
                      ? '…'
                      : t('requestsSurface.conductorContext.send')}
                  </em>
                </button>
              );
            })}
          </div>
          <p>{t('requestsSurface.conductorContext.hint')}</p>
        </section>
      )}

      <div className="request-compose">
        <div className="request-kind-tabs">
          {kinds.map(item => (
            <button
              key={item}
              className={kind === item ? 'active' : ''}
              onClick={() => setKind(item)}
            >
              {t(`requestsSurface.kinds.${item}`)}
            </button>
          ))}
        </div>
        <div className="request-compose-meta">
          <p className="request-kind-hint">{t(`requestsSurface.kindHints.${kind}`)}</p>
          <button
            type="button"
            className={priority === 'urgent' ? 'request-priority active' : 'request-priority'}
            aria-pressed={priority === 'urgent'}
            onClick={() => setPriority(current => current === 'urgent' ? 'normal' : 'urgent')}
          >
            {priority === 'urgent'
              ? t('requestsSurface.priorityUrgentActive')
              : t('requestsSurface.priorityUrgent')}
          </button>
        </div>
        <div className="request-input-row">
          <input
            value={value}
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              if (mode === 'pastor' && kind === 'bible') {
                if (bibleRouteRequired) return;
                if (bibleSearchProvider) {
                  if (biblePreview) void submitCheckedBible();
                  else void checkBibleReference();
                  return;
                }
              }
              void submit();
            }}
            placeholder={t(`requestsSurface.placeholders.${kind}`)}
          />
          {mode === 'pastor' && kind === 'bible' && bibleSearchProvider ? (
            <button
              className="secondary"
              disabled={!value.trim() || checkingBible || sending}
              onClick={() => void checkBibleReference()}
            >
              {checkingBible ? '…' : t('requestsSurface.bibleCheck')}
            </button>
          ) : (
            <button
              className="primary"
              disabled={
                !value.trim() ||
                sending ||
                (mode === 'pastor' && kind === 'bible' && bibleRouteRequired)
              }
              onClick={() => void submit()}
            >
              {sending ? '…' : t('requestsSurface.send')}
            </button>
          )}
        </div>

        {mode === 'pastor' && kind === 'bible' && bibleRouteRequired && (
          <p className="request-route-hint">
            {t('requestsSurface.bibleRouteRequiredHint')}
          </p>
        )}

        {mode === 'pastor' && kind === 'bible' && bibleSearchProvider && (
          <div className="pastor-bible-preview-shell">
            {biblePreview ? (
              <div className="pastor-bible-preview">
                <div>
                  <small>{t('requestsSurface.bibleChecked')}</small>
                  <strong>{biblePreview.reference}</strong>
                  <span>
                    {t('requestsSurface.bibleCheckedMeta', {
                      count: biblePreview.verseCount,
                      provider: bibleSearchProvider.displayName || bibleSearchProvider.providerKey
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  className="primary"
                  disabled={sending}
                  onClick={() => void submitCheckedBible()}
                >
                  {sending ? '…' : t('requestsSurface.sendCheckedBible')}
                </button>
              </div>
            ) : (
              <p>{t('requestsSurface.bibleCheckHint')}</p>
            )}
            {bibleError && (
              <p className="request-action-error">
                {t(`requestsSurface.bibleErrors.${bibleError}`, {
                  defaultValue: t('requestsSurface.bibleErrors.generic')
                })}
              </p>
            )}
          </div>
        )}

        {sent && <p className="request-sent">{t('requestsSurface.sent')}</p>}
      </div>

      <TeamChatPanel
        controller={controller}
        actorId={actorId}
        liveSessionId={liveSessionId}
        senderContext={mode}
        compact
      />

      <div className="request-history">
        <div className="request-history-head">
          <strong>{t('requestsSurface.myRequests')}</strong>
          <small>{t('requestsSurface.operatorDecides')}</small>
        </div>
        {ownRequests.length ? ownRequests.map(request => {
          const label =
            request.kind === 'bible' ? request.payload.reference :
            request.kind === 'song' ? request.payload.query :
            request.kind === 'section' ? request.payload.section :
            request.kind === 'media' ? request.payload.query :
            request.payload.text;
          return (
            <article key={request.id} className={`request-history-item status-${request.status}`}>
              <div>
                <small>{t(`requestsSurface.kinds.${request.kind}`)}</small>
                <strong>{String(label || '')}</strong>
              </div>
              <div className="request-history-status">
                <span>{t(`requestsSurface.status.${request.status}`)}</span>
                {(request.status === 'sent' || request.status === 'seen') && (
                  <button
                    type="button"
                    disabled={Boolean(cancellingId)}
                    onClick={() => void cancelRequest(request.id)}
                  >
                    {cancellingId === request.id
                      ? '…'
                      : t('requestsSurface.cancel')}
                  </button>
                )}
              </div>
            </article>
          );
        }) : (
          <p className="muted">{t('requestsSurface.empty')}</p>
        )}
      </div>
    </section>
  );
}
