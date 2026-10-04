import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LiveChatAudience,
  LiveChatMessage,
  LiveChatSenderContext
} from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';

type Controller = ReturnType<typeof useLiveNode>;

function audiencesFor(context: LiveChatSenderContext): LiveChatAudience[] {
  if (context === 'operator') {
    return ['team', 'pastor', 'conductor', 'production'];
  }
  if (context === 'pastor') {
    return ['team', 'operator', 'production'];
  }
  if (context === 'conductor') {
    return ['team', 'operator', 'production'];
  }
  return ['team', 'operator', 'production'];
}

function canSeeMessage(
  message: LiveChatMessage,
  context: LiveChatSenderContext,
  actorId: string
): boolean {
  if (message.actorId === actorId) return true;
  if (context === 'operator') return true;
  if (message.audience === 'team') return true;
  if (message.audience === context) return true;
  if (context === 'team' && message.audience === 'production') return true;
  return false;
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function TeamChatPanel({
  controller,
  actorId,
  liveSessionId,
  senderContext,
  compact = false
}: {
  controller: Controller;
  actorId: string;
  liveSessionId: string;
  senderContext: LiveChatSenderContext;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<LiveChatMessage[]>([]);
  const [text, setText] = useState('');
  const [audience, setAudience] = useState<LiveChatAudience>('team');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const audienceOptions = useMemo(
    () => audiencesFor(senderContext),
    [senderContext]
  );

  useEffect(() => {
    if (!audienceOptions.includes(audience)) {
      setAudience(audienceOptions[0] || 'team');
    }
  }, [audience, audienceOptions]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const next = await controller.listChatMessages(liveSessionId, 120);
        if (cancelled) return;
        setMessages(next);
        setLoadError(false);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    };

    void load();
    timer = window.setInterval(() => void load(), 1600);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [controller.listChatMessages, liveSessionId]);

  const visibleMessages = useMemo(
    () => messages.filter(message =>
      canSeeMessage(message, senderContext, actorId)
    ),
    [actorId, messages, senderContext]
  );

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [visibleMessages.length]);

  async function send() {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      const message = await controller.sendChatMessage({
        liveSessionId,
        actorId,
        senderContext,
        audience,
        text: value,
        relatedServiceItemId: controller.nodeState?.state.activeServiceItemId || undefined
      });
      setMessages(current => {
        if (current.some(item => item.id === message.id)) return current;
        return [...current, message];
      });
      setText('');
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={compact ? 'team-chat compact' : 'team-chat'}>
      <header className="team-chat-head">
        <div>
          <span>{t('teamChat.kicker')}</span>
          <strong>{t('teamChat.title')}</strong>
          <small>{t('teamChat.safeHint')}</small>
        </div>
        <em>{t('teamChat.informational')}</em>
      </header>

      <div className="team-chat-list" ref={listRef} aria-live="polite">
        {visibleMessages.map(message => {
          const own = message.actorId === actorId;
          return (
            <article
              key={message.id}
              className={own ? 'team-chat-message own' : 'team-chat-message'}
            >
              <div className="team-chat-message-meta">
                <span>
                  {t(`teamChat.sender.${message.senderContext}`, {
                    defaultValue: message.senderContext
                  })}
                </span>
                <b>
                  {t(`teamChat.audience.${message.audience}`, {
                    defaultValue: message.audience
                  })}
                </b>
                <time dateTime={message.createdAt}>
                  {timeLabel(message.createdAt)}
                </time>
              </div>
              <p>{message.text}</p>
              {message.relatedServiceItemId && (
                <small className="team-chat-context">
                  {t('teamChat.serviceItemContext')}
                </small>
              )}
            </article>
          );
        })}

        {!visibleMessages.length && !loadError && (
          <div className="team-chat-empty">
            <strong>{t('teamChat.emptyTitle')}</strong>
            <span>{t('teamChat.emptyHint')}</span>
          </div>
        )}

        {loadError && !visibleMessages.length && (
          <div className="team-chat-empty warning">
            <strong>{t('teamChat.unavailableTitle')}</strong>
            <span>{t('teamChat.unavailableHint')}</span>
          </div>
        )}
      </div>

      <div className="team-chat-compose">
        <select
          value={audience}
          onChange={event => setAudience(event.target.value as LiveChatAudience)}
          aria-label={t('teamChat.audienceLabel')}
        >
          {audienceOptions.map(option => (
            <option key={option} value={option}>
              {t(`teamChat.audience.${option}`, { defaultValue: option })}
            </option>
          ))}
        </select>
        <textarea
          value={text}
          maxLength={1200}
          rows={compact ? 2 : 3}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={t('teamChat.placeholder')}
        />
        <button
          type="button"
          className="primary"
          disabled={!text.trim() || sending}
          onClick={() => void send()}
        >
          {sending ? '…' : t('teamChat.send')}
        </button>
      </div>

      <footer>
        <span>{t('teamChat.actionHint')}</span>
        {loadError && <em>{t('teamChat.retrying')}</em>}
      </footer>
    </section>
  );
}
