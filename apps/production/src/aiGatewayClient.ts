import { auth } from './firebase';

export type LiveAiTask =
  | 'diagnostic_explanation'
  | 'song_match_assist'
  | 'request_classification'
  | 'natural_search'
  | 'metadata_normalization'
  | 'post_service_summary'
  | 'pre_service_risk_summary';

export interface LiveAiSuggestion {
  kind: string;
  label: string;
  reason: string;
  value?: string;
}

export interface LiveAiResult {
  summary: string;
  confidence: number;
  suggestions: LiveAiSuggestion[];
  warnings: string[];
}

export interface LiveAiGatewayResponse {
  success: boolean;
  task?: LiveAiTask;
  fromCache?: boolean;
  model?: string;
  result?: LiveAiResult;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    latencyMs?: number;
    monthlyRequests?: number;
    monthlyLimit?: number;
  };
  reasonCode?: string;
  fallback?: string;
}

const API_BASE = (
  import.meta.env.VITE_MILLIONSNEST_API_BASE_URL ||
  'https://www.millionsnest.com'
).replace(/\/$/, '');

export async function requestLiveAiInsight(input: {
  organizationId: string;
  task: LiveAiTask;
  data: unknown;
}): Promise<LiveAiGatewayResponse> {
  const user = auth.currentUser;
  if (!user) throw new Error('ai_auth_required');
  const token = await user.getIdToken();

  const response = await fetch(
    `${API_BASE}/api/v1/organizations/${encodeURIComponent(input.organizationId)}/nestlive/ai`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        task: input.task,
        input: input.data
      })
    }
  );

  const payload = await response.json().catch(() => ({})) as LiveAiGatewayResponse;
  if (!response.ok || payload.success !== true || !payload.result) {
    throw new Error(payload.reasonCode || `ai_http_${response.status}`);
  }
  return payload;
}
