import type { GraphFailure } from '../domain/graph-errors.js';
import { sanitizeProviderMessage } from '../domain/graph-errors.js';

export interface GraphChannel {
  api_version: string;
  phone_number_id: string;
  business_account_id: string;
}

export type GraphResult<T> = { ok: true; status: number; body: T } | ({ ok: false } & GraphFailure);

export interface GraphSendResponse {
  messaging_product?: string;
  contacts?: { input?: string; wa_id?: string; user_id?: string }[];
  messages?: { id: string; message_status?: string }[];
}

export interface GraphTemplate {
  id?: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: unknown[];
  rejected_reason?: string;
}

export interface GraphPhoneNumber {
  quality_rating?: string;
  whatsapp_business_manager_messaging_limit?: string;
  messaging_limit_tier?: string;
  health_status?: { can_send_message?: string };
}

export interface GraphClientOptions {
  /** WA_GRAPH_BASE_URL: https://graph.facebook.com, or the simulator */
  baseUrl: string;
  /** WA_HTTP_TIMEOUT_MS */
  timeoutMs: number;
  fetch?: typeof fetch;
}

/**
 * Cloud API client (12 §5.11). Every URL is `{WA_GRAPH_BASE_URL}/{api_version}/…` with the version pinned
 * on the channel row (12 §3.5); every call has an explicit timeout. The token is only ever placed in
 * the Authorization header and never logged.
 */
export class GraphClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: GraphClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  url(ch: GraphChannel, ...parts: string[]): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    return [base, ch.api_version, ...parts].map((p, i) => (i === 0 ? p : encodeURIComponent(p))).join('/');
  }

  async request<T>(
    method: 'GET' | 'POST',
    url: string,
    token: string,
    body?: unknown,
  ): Promise<GraphResult<T>> {
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = null;
      }
      if (res.ok) return { ok: true, status: res.status, body: (json ?? {}) as T };
      const err = json && typeof json === 'object' ? (json.error ?? {}) : {};
      return {
        ok: false,
        kind: 'http',
        status: res.status,
        code: typeof err.code === 'number' ? err.code : null,
        message:
          sanitizeProviderMessage(
            [err.message, err.error_data?.details].filter((x) => typeof x === 'string').join(' — ') ||
              `HTTP ${res.status}`,
          ) ?? `HTTP ${res.status}`,
      };
    } catch (e) {
      const name = (e as Error)?.name;
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      return {
        ok: false,
        kind: timeout ? 'timeout' : 'network',
        status: null,
        code: null,
        message: timeout ? `no answer within ${this.opts.timeoutMs} ms` : 'provider unreachable',
      };
    }
  }

  /** POST /{v}/{phone_number_id}/messages */
  sendMessage(ch: GraphChannel, token: string, body: unknown) {
    return this.request<GraphSendResponse>('POST', this.url(ch, ch.phone_number_id, 'messages'), token, body);
  }

  /** GET /{v}/{phone_number_id} — the health probe of 12 §5.14 */
  phoneNumber(ch: GraphChannel, token: string) {
    return this.request<GraphPhoneNumber>('GET', this.url(ch, ch.phone_number_id), token);
  }

  /** GET /{v}/{waba_id}/message_templates (first page of 100; the catalog has eight) */
  listTemplates(ch: GraphChannel, token: string) {
    return this.request<{ data?: GraphTemplate[] }>(
      'GET',
      `${this.url(ch, ch.business_account_id, 'message_templates')}?limit=100`,
      token,
    );
  }

  /** POST /{v}/{waba_id}/message_templates */
  createTemplate(ch: GraphChannel, token: string, definition: unknown) {
    return this.request<{ id?: string; status?: string; category?: string }>(
      'POST',
      this.url(ch, ch.business_account_id, 'message_templates'),
      token,
      definition,
    );
  }
}
