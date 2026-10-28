import { defaultTemplates, templateKey } from './catalog.js';
import { DEFAULT_PHONE_NUMBER_ID, defaultConfig, type SimulatorConfig } from './config.js';
import { HttpError } from './http-util.js';
import { bsuidFor, digitsOnly, looksLikeBsuid } from './ids.js';
import type {
  ActiveFault,
  ChannelSetting,
  ChannelState,
  FaultRule,
  FaultsView,
  InboundMessage,
  MessageFilter,
  MessageSelector,
  OutboundMessage,
  SendAttempt,
  SimulatorConfigView,
  TemplateInfo,
  WebhookDelivery,
} from './types.js';

const MAX_LOG = 10_000;

export interface Identity {
  waId: string | null;
  userId: string | null;
  /** Conversation key: the phone digits when known, otherwise the BSUID. */
  key: string;
}

export interface FaultContext {
  waId: string | null;
  userId: string | null;
  template: string | null;
  purpose: string | null;
  type: string | null;
}

/** All in-memory state of one simulator instance. Nothing is persisted. */
export class SimulatorState {
  config: SimulatorConfig;
  readonly templates = new Map<string, TemplateInfo>();
  readonly outbound: OutboundMessage[] = [];
  readonly inbound: InboundMessage[] = [];
  readonly deliveries: WebhookDelivery[] = [];
  readonly attempts: SendAttempt[] = [];
  faults: ActiveFault[] = [];
  latencyMs = 0;
  statusDelayOverride: { delayMs: number; remaining: number } | null = null;
  /** Semantic keys of sends already failed once by the …1111 rule. */
  readonly pairRuleSeen = new Set<string>();
  /** BSUID → phone digits, learnt from every phone the simulator has seen. */
  readonly identities = new Map<string, string>();
  lastPhoneNumberId: string | null = null;

  private channel: ChannelState = { state: 'up', code: null, httpStatus: null, until: null };
  private readonly byWamid = new Map<string, OutboundMessage>();
  private readonly initialConfig: SimulatorConfig;
  private readonly sleepers = new Set<{ timer: NodeJS.Timeout; resolve: (ok: boolean) => void }>();
  private epochValue = 0;
  private seq = 0;
  private deliverySeq = 0;
  private faultSeq = 0;
  private templateSeq = 0;

  constructor(
    config: Partial<SimulatorConfig> = {},
    readonly log: (line: string) => void = () => {},
  ) {
    this.config = defaultConfig(config);
    this.initialConfig = { ...this.config };
    this.loadTemplates();
  }

  nextSeq(): number {
    return ++this.seq;
  }

  nextDeliveryId(): number {
    return ++this.deliverySeq;
  }

  nextTemplateId(): string {
    return String(910000000000000 + ++this.templateSeq);
  }

  /**
   * Resolves true after `ms`; false right away when the state was reset or closed meanwhile — or before, when
   * the caller passes the `epoch` it started in (background chains stop after a reset).
   */
  sleep(ms: number, epoch: number = this.epoch): Promise<boolean> {
    if (epoch !== this.epoch) return Promise.resolve(false);
    if (ms <= 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const entry = {
        timer: setTimeout(() => {
          this.sleepers.delete(entry);
          resolve(epoch === this.epoch);
        }, ms),
        resolve,
      };
      this.sleepers.add(entry);
    });
  }

  /** Incremented by reset/close: work started in an older epoch must not continue. */
  get epoch(): number {
    return this.epochValue;
  }

  cancelTimers(): void {
    this.epochValue += 1;
    for (const s of this.sleepers) {
      clearTimeout(s.timer);
      s.resolve(false);
    }
    this.sleepers.clear();
  }

  /** Clears messages, webhooks, faults and templates; keeps the runtime config unless `resetConfig`. */
  reset(resetConfig = false): void {
    this.cancelTimers();
    this.outbound.length = 0;
    this.inbound.length = 0;
    this.deliveries.length = 0;
    this.attempts.length = 0;
    this.byWamid.clear();
    this.faults = [];
    this.latencyMs = 0;
    this.statusDelayOverride = null;
    this.pairRuleSeen.clear();
    this.identities.clear();
    this.lastPhoneNumberId = null;
    this.channel = { state: 'up', code: null, httpStatus: null, until: null };
    this.loadTemplates();
    if (resetConfig) this.config = { ...this.initialConfig };
  }

  private loadTemplates(): void {
    this.templates.clear();
    for (const t of defaultTemplates()) this.templates.set(templateKey(t.name, t.language), t);
  }

  effectivePhoneNumberId(): string {
    return this.config.phoneNumberId ?? this.lastPhoneNumberId ?? DEFAULT_PHONE_NUMBER_ID;
  }

  /** Resolves a phone (any format) or a BSUID to the simulator identity. */
  identify(idOrPhone: string): Identity {
    const value = idOrPhone.trim();
    if (looksLikeBsuid(value)) {
      const waId = this.identities.get(value) ?? null;
      return { waId, userId: value, key: waId ?? value };
    }
    const waId = digitsOnly(value);
    if (!waId) throw new HttpError(400, 'invalid_number', `not a phone number or BSUID: ${idOrPhone}`);
    const userId = bsuidFor(waId);
    this.identities.set(userId, waId);
    return { waId, userId, key: waId };
  }

  addOutbound(msg: OutboundMessage): void {
    this.outbound.push(msg);
    this.byWamid.set(msg.wamid, msg);
    while (this.outbound.length > MAX_LOG) {
      const dropped = this.outbound.shift();
      if (dropped) this.byWamid.delete(dropped.wamid);
    }
  }

  getOutbound(wamid: string): OutboundMessage | undefined {
    return this.byWamid.get(wamid);
  }

  addInbound(msg: InboundMessage): void {
    this.inbound.push(msg);
    trim(this.inbound);
  }

  addDelivery(d: WebhookDelivery): void {
    this.deliveries.push(d);
    trim(this.deliveries);
  }

  addAttempt(a: SendAttempt): void {
    this.attempts.push(a);
    trim(this.attempts);
  }

  private matchesTo(msg: OutboundMessage, to: string): boolean {
    const id = this.identify(to);
    return msg.conversation === id.key || (id.userId !== null && msg.userId === id.userId);
  }

  findMessages(filter: MessageFilter & { ticketNumber?: string; withButtons?: boolean }): OutboundMessage[] {
    return this.outbound.filter(
      (m) =>
        (filter.to === undefined || this.matchesTo(m, filter.to)) &&
        (filter.template === undefined || m.templateName === filter.template) &&
        (filter.purpose === undefined || m.purpose === filter.purpose) &&
        (filter.type === undefined || m.type === filter.type) &&
        (filter.phoneNumberId === undefined || m.phoneNumberId === filter.phoneNumberId) &&
        (filter.afterSeq === undefined || m.seq > filter.afterSeq) &&
        (filter.ticketNumber === undefined ||
          m.bodyParams[m.purpose === 'W-01' ? 1 : 0] === filter.ticketNumber) &&
        (!filter.withButtons || m.buttons.length > 0),
    );
  }

  /** One outbound message by wamid, or the latest (or `index`-th) match of the selector. */
  selectMessage(selector: MessageSelector, opts: { withButtons?: boolean } = {}): OutboundMessage {
    if (selector.wamid) {
      const m = this.getOutbound(selector.wamid);
      if (!m) throw new HttpError(404, 'message_not_found', `no outbound message ${selector.wamid}`);
      return m;
    }
    if (!selector.to && !selector.template && !selector.purpose && !selector.ticketNumber) {
      throw new HttpError(400, 'selector_required', 'give wamid, or to/template/purpose/ticketNumber');
    }
    const matches = this.findMessages({
      ...(selector.to !== undefined ? { to: selector.to } : {}),
      ...(selector.template !== undefined ? { template: selector.template } : {}),
      ...(selector.purpose !== undefined ? { purpose: selector.purpose } : {}),
      ...(selector.ticketNumber !== undefined ? { ticketNumber: selector.ticketNumber } : {}),
      withButtons: opts.withButtons ?? false,
    });
    const picked = selector.index === undefined ? matches.at(-1) : matches[selector.index];
    if (!picked) {
      const what = opts.withButtons ? 'message with a quick-reply button' : 'message';
      throw new HttpError(
        404,
        'message_not_found',
        `no outbound ${what} matches ${JSON.stringify(selector)}`,
      );
    }
    return picked;
  }

  channelState(): ChannelState {
    if (this.channel.until && Date.parse(this.channel.until) <= Date.now()) {
      this.channel = { state: 'up', code: null, httpStatus: null, until: null };
      this.log('channel: recovered (duration elapsed)');
    }
    return this.channel;
  }

  setChannel(setting: ChannelSetting): ChannelState {
    if (setting.state === 'up') {
      this.channel = { state: 'up', code: null, httpStatus: null, until: null };
    } else {
      const code = setting.state === 'down' ? (setting.code ?? 131016) : null;
      this.channel = {
        state: setting.state,
        code,
        httpStatus: setting.state === 'down' ? (setting.httpStatus ?? (code === 131016 ? 503 : null)) : null,
        until: setting.durationMs ? new Date(Date.now() + setting.durationMs).toISOString() : null,
      };
    }
    this.log(`channel: ${this.channel.state}${this.channel.code ? ` code=${this.channel.code}` : ''}`);
    return this.channel;
  }

  addFault(rule: FaultRule): ActiveFault {
    const count = rule.count ?? 1;
    const fault: ActiveFault = { ...rule, id: ++this.faultSeq, remaining: count, hits: 0 };
    this.faults.push(fault);
    return fault;
  }

  /** First active fault matching the send; consumes one use. */
  takeFault(ctx: FaultContext): ActiveFault | null {
    for (const f of this.faults) {
      if (f.remaining !== 'unlimited' && f.remaining <= 0) continue;
      const m = f.match;
      if (m?.to !== undefined) {
        const id = this.identify(m.to);
        if (!((id.waId && id.waId === ctx.waId) || (id.userId && id.userId === ctx.userId))) continue;
      }
      if (m?.template !== undefined && m.template !== ctx.template) continue;
      if (m?.purpose !== undefined && m.purpose !== ctx.purpose) continue;
      if (m?.type !== undefined && m.type !== ctx.type) continue;
      if (f.remaining !== 'unlimited') f.remaining -= 1;
      f.hits += 1;
      return f;
    }
    return null;
  }

  faultsView(): FaultsView {
    return {
      rules: this.faults.map((f) => ({ ...f })),
      channel: { ...this.channelState() },
      latencyMs: this.latencyMs,
      statusDelayOverride: this.statusDelayOverride ? { ...this.statusDelayOverride } : null,
    };
  }

  clearFaults(): void {
    this.faults = [];
    this.latencyMs = 0;
    this.statusDelayOverride = null;
    this.channel = { state: 'up', code: null, httpStatus: null, until: null };
  }

  configView(): SimulatorConfigView {
    const c = this.config;
    return {
      webhookUrl: c.webhookUrl,
      appSecretSet: c.appSecret.length > 0,
      verifyTokenSet: c.verifyToken !== null,
      accessTokenSet: c.accessToken !== null,
      phoneNumberId: c.phoneNumberId,
      effectivePhoneNumberId: this.effectivePhoneNumberId(),
      wabaId: c.wabaId,
      displayPhoneE164: c.displayPhoneE164,
      autoStatuses: c.autoStatuses,
      statusDelayMs: c.statusDelayMs,
      statusOrder: c.statusOrder,
      statusSequence: [...c.statusSequence],
      webhookRetries: c.webhookRetries,
      webhookRetryDelayMs: c.webhookRetryDelayMs,
      webhookTimeoutMs: c.webhookTimeoutMs,
      templateApprovalDelayMs: c.templateApprovalDelayMs,
      deterministicFaults: c.deterministicFaults,
      includeUserIds: c.includeUserIds,
      hangMs: c.hangMs,
    };
  }
}

function trim<T>(list: T[]): void {
  if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG);
}
