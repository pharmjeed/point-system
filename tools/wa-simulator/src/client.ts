import { readFile } from 'node:fs/promises';
import type {
  ActiveFault,
  ChannelSetting,
  ClaimCodeResult,
  Conversation,
  ConversationSummary,
  EmitResult,
  FaultRule,
  FaultsView,
  InboundOptions,
  InteractiveOptions,
  MessageFilter,
  OutboundMessage,
  PressOptions,
  RawWebhookOptions,
  ScenarioDocument,
  ScenarioResult,
  SendAttempt,
  SimulatorConfigPatch,
  SimulatorConfigView,
  StatusOptions,
  TemplateInfo,
  TemplateStatus,
  TextOptions,
  VerifyWebhookResult,
  WebhookDelivery,
} from './types.js';

export interface SimulatorClientOptions {
  /** Simulator base URL, e.g. http://localhost:4010 */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per-request timeout (default 30 s; scenario runs can take a while). */
  timeoutMs?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export class SimulatorClientError extends Error {
  override readonly name = 'SimulatorClientError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** Typed wrapper around the simulator control API (`/_sim/*`). */
export class SimulatorClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: string | SimulatorClientOptions) {
    const o = typeof options === 'string' ? { baseUrl: options } : options;
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/_sim${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new SimulatorClientError(
        res.status,
        err?.code ?? `http_${res.status}`,
        `wa-simulator ${method} ${path} → ${res.status}: ${err?.message ?? text}`,
        json,
      );
    }
    return json as T;
  }

  private static query(filter: object): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== null) q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  // --- lifecycle & config -------------------------------------------------------------------------------
  health(): Promise<{ ok: boolean; webhookUrl: string | null; phoneNumberId: string; channel: string }> {
    return this.request('GET', '/health');
  }

  /** Clears messages, webhooks, faults and template statuses (config kept unless resetConfig). */
  async reset(opts: { resetConfig?: boolean } = {}): Promise<void> {
    await this.request('POST', '/reset', opts);
  }

  getConfig(): Promise<SimulatorConfigView> {
    return this.request('GET', '/config');
  }

  /** e.g. `configure({ webhookUrl: apiUrl + '/webhooks/whatsapp', autoStatuses: false })` */
  configure(patch: SimulatorConfigPatch): Promise<SimulatorConfigView> {
    return this.request('PATCH', '/config', patch);
  }

  // --- outbound messages (what the business sent) -------------------------------------------------------
  async listMessages(filter: MessageFilter = {}): Promise<OutboundMessage[]> {
    return (
      await this.request<{ data: OutboundMessage[] }>('GET', `/messages${SimulatorClient.query(filter)}`)
    ).data;
  }

  getMessage(wamid: string): Promise<OutboundMessage> {
    return this.request('GET', `/messages/${encodeURIComponent(wamid)}`);
  }

  /** Last message sent to a number (optionally of one template/purpose); null when there is none. */
  async lastMessage(to: string, filter: Omit<MessageFilter, 'to'> = {}): Promise<OutboundMessage | null> {
    try {
      return await this.request<OutboundMessage>(
        'GET',
        `/customers/${encodeURIComponent(to)}/last-message${SimulatorClient.query(filter)}`,
      );
    } catch (err) {
      if (err instanceof SimulatorClientError && err.status === 404) return null;
      throw err;
    }
  }

  /** Polls until a message matching the filter (and newer than `afterSeq`) arrives. */
  async waitForMessage(filter: MessageFilter, opts: WaitOptions = {}): Promise<OutboundMessage> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5000);
    for (;;) {
      const found = (await this.listMessages(filter))[0];
      if (found) return found;
      if (Date.now() >= deadline) {
        throw new SimulatorClientError(
          408,
          'wait_timeout',
          `no message matching ${JSON.stringify(filter)}`,
          null,
        );
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 25));
    }
  }

  async sendAttempts(): Promise<SendAttempt[]> {
    return (await this.request<{ data: SendAttempt[] }>('GET', '/send-attempts')).data;
  }

  /** The handover code of the last W-05 (`masaf_vehicle_ready_v1`, or its session-text fallback) to a number. */
  async claimCode(to: string): Promise<string | null> {
    return (await this.claimCodeDetails(to))?.code ?? null;
  }

  async claimCodeDetails(to: string): Promise<ClaimCodeResult | null> {
    try {
      return await this.request<ClaimCodeResult>('GET', `/customers/${encodeURIComponent(to)}/claim-code`);
    } catch (err) {
      if (err instanceof SimulatorClientError && err.status === 404) return null;
      throw err;
    }
  }

  async conversations(): Promise<ConversationSummary[]> {
    return (await this.request<{ data: ConversationSummary[] }>('GET', '/conversations')).data;
  }

  conversation(id: string): Promise<Conversation> {
    return this.request('GET', `/conversations/${encodeURIComponent(id)}`);
  }

  // --- inbound webhooks (customer → business) -----------------------------------------------------------
  /** Presses the quick-reply button of a sent template (by wamid, or the latest one to `to`). */
  pressButton(opts: PressOptions): Promise<EmitResult> {
    return this.request('POST', '/press', opts);
  }

  /** The customer `waId` presses the button of its latest W-01 (or `opts.wamid`). */
  tap(waId: string, opts: Omit<PressOptions, 'to'> = {}): Promise<EmitResult> {
    return this.request('POST', '/press', { from: waId, to: opts.wamid ? undefined : waId, ...opts });
  }

  sendText(opts: TextOptions): Promise<EmitResult> {
    return this.request('POST', '/text', opts);
  }

  /** Sends the prefilled QR text with the link code (docs/12 §7.2). */
  sendLinkCode(from: string, code: string, opts: InboundOptions = {}): Promise<EmitResult> {
    return this.request('POST', '/link-code', { ...opts, from, code });
  }

  /** Sends the stop keyword (default «إيقاف»). */
  sendStop(from: string, opts: InboundOptions & { keyword?: string } = {}): Promise<EmitResult> {
    return this.request('POST', '/stop', { ...opts, from });
  }

  sendInteractive(opts: InteractiveOptions): Promise<EmitResult> {
    return this.request('POST', '/interactive', opts);
  }

  /** Status webhooks for a sent message: order natural / reversed / duplicated / reorder / shuffled. */
  emitStatuses(opts: StatusOptions): Promise<EmitResult> {
    return this.request('POST', '/statuses', opts);
  }

  /** Any body (object or exact raw string) with a valid, invalid or missing signature. */
  emitRaw(opts: RawWebhookOptions): Promise<EmitResult> {
    return this.request('POST', '/webhooks/raw', opts);
  }

  async webhookDeliveries(): Promise<WebhookDelivery[]> {
    return (await this.request<{ data: WebhookDelivery[] }>('GET', '/webhooks')).data;
  }

  /** Runs Meta's GET verification handshake against the webhook URL. */
  verifyWebhook(
    opts: { verifyToken?: string; challenge?: string; webhookUrl?: string } = {},
  ): Promise<VerifyWebhookResult> {
    return this.request('POST', '/verify-webhook', opts);
  }

  // --- faults --------------------------------------------------------------------------------------------
  faults(): Promise<FaultsView> {
    return this.request('GET', '/faults');
  }

  /** Next matching send(s) fail, e.g. `{ code: 131056 }`, `{ code: 131026, mode: 'async' }`, `{ httpStatus: 503, count: 3 }`. */
  async addFault(rule: FaultRule): Promise<ActiveFault> {
    const view = await this.request<FaultsView>('POST', '/faults', rule);
    return view.rules.at(-1) as ActiveFault;
  }

  addFaults(rules: FaultRule[]): Promise<FaultsView> {
    return this.request('POST', '/faults', { rules });
  }

  /** Removes rules, latency, status delays and brings the channel back up. */
  clearFaults(): Promise<FaultsView> {
    return this.request('DELETE', '/faults');
  }

  /** `down`: every Graph call fails (default 131016/503) · `timeout`: calls hang · `up`: normal. */
  setChannel(setting: ChannelSetting): Promise<FaultsView> {
    return this.request('POST', '/channel', setting);
  }

  setLatency(ms: number): Promise<FaultsView> {
    return this.request('POST', '/latency', { ms });
  }

  /** Holds the status webhooks of the next `count` accepted sends for `delayMs` (crash_after_accept). */
  delayStatuses(delayMs: number, count = 1): Promise<FaultsView> {
    return this.request('POST', '/status-delay', { delayMs, count });
  }

  // --- templates -----------------------------------------------------------------------------------------
  async templates(): Promise<TemplateInfo[]> {
    return (await this.request<{ data: TemplateInfo[] }>('GET', '/templates')).data;
  }

  /** e.g. pause W-05 to test the fallback: `setTemplateStatus('masaf_vehicle_ready_v1', 'PAUSED')`. */
  setTemplateStatus(
    name: string,
    status: TemplateStatus,
    opts: { language?: string; emitWebhook?: boolean; reason?: string } = {},
  ): Promise<TemplateInfo> {
    return this.request('POST', `/templates/${encodeURIComponent(name)}/status`, { ...opts, status });
  }

  // --- scenarios -----------------------------------------------------------------------------------------
  async scenarios(): Promise<string[]> {
    return (await this.request<{ data: string[] }>('GET', '/scenarios')).data;
  }

  /** Built-in scenario of docs/12 §11.4: dup10, taps10, reorder, forwarded, two_tickets, two_venues, … */
  runScenario(name: string, params: Record<string, unknown> = {}): Promise<ScenarioResult> {
    return this.request('POST', `/scenarios/${encodeURIComponent(name)}`, params);
  }

  runScenarioDocument(doc: ScenarioDocument): Promise<ScenarioResult> {
    return this.request('POST', '/scenarios', doc);
  }

  /** Reads a scenario JSON file (see scenarios/*.json) and replays it. */
  async runScenarioFile(path: string | URL): Promise<ScenarioResult> {
    return this.runScenarioDocument(JSON.parse(await readFile(path, 'utf8')) as ScenarioDocument);
  }
}
