import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  requestLiveAiInsight,
  type LiveAiGatewayResponse,
  type LiveAiTask
} from './aiGatewayClient';

export function AiInsightPanel({
  organizationId,
  task,
  input,
  compact = false
}: {
  organizationId: string;
  task: LiveAiTask;
  input: unknown;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [response, setResponse] = useState<LiveAiGatewayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      setResponse(await requestLiveAiInsight({
        organizationId,
        task,
        data: input
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'ai_unavailable');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className={`ai-insight-panel ${compact ? 'compact' : ''}`}>
      <div className="ai-insight-head">
        <div>
          <small>{t('aiAssist.kicker')}</small>
          <strong>{t(`aiAssist.tasks.${task}`)}</strong>
          <span>{t('aiAssist.humanReview')}</span>
        </div>
        <button type="button" className="secondary" disabled={loading} onClick={() => void run()}>
          {loading ? t('aiAssist.thinking') : t('aiAssist.analyze')}
        </button>
      </div>

      {error && (
        <div className="ai-insight-fallback" role="status">
          <strong>{t('aiAssist.unavailableTitle')}</strong>
          <span>{t('aiAssist.unavailableHint')}</span>
          <small>{error}</small>
        </div>
      )}

      {response?.result && (
        <div className="ai-insight-result">
          <p>{response.result.summary}</p>
          {response.result.suggestions.length > 0 && (
            <div className="ai-insight-suggestions">
              {response.result.suggestions.map((suggestion, index) => (
                <article key={`${suggestion.kind}:${index}`}>
                  <small>{suggestion.kind}</small>
                  <strong>{suggestion.label}</strong>
                  <span>{suggestion.reason}</span>
                </article>
              ))}
            </div>
          )}
          {response.result.warnings.length > 0 && (
            <div className="ai-insight-warnings">
              {response.result.warnings.map((warning, index) => (
                <span key={`${warning}:${index}`}>{warning}</span>
              ))}
            </div>
          )}
          <footer>
            <span>{t('aiAssist.confidence', {
              value: Math.round(response.result.confidence * 100)
            })}</span>
            {response.model && <span>{response.model}</span>}
            {response.usage?.latencyMs !== undefined && (
              <span>{Math.round(response.usage.latencyMs)} ms</span>
            )}
            {response.fromCache && <span>{t('aiAssist.cached')}</span>}
          </footer>
        </div>
      )}
    </section>
  );
}
