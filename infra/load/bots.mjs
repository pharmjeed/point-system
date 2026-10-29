// Virtual staff of the load profile (17 H-08): drivers on Socket.IO who accept offers after 1–10 s and run the
// retrieval with compressed steps through the real routes, and supervisors whose sockets observe every task.
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiClient, connected } from '../harness/api.mjs';
import { intakeAndPark, must } from '../harness/flows.mjs';

/** Socket observations shared by every bot of the run. */
export const observed = {
  /** `task.claimed` at a driver socket: { taskId, userId, winnerId, at } */
  claimed: [],
  /** first `task.updated` per task at a supervisor socket: taskId → epoch ms */
  firstTaskUpdate: new Map(),
  /** `task.offered` / `task.broadcast` arrivals: { taskId, offerId, userId, mode, eligible, at } */
  offers: [],
  /** handshake refusals and disconnects */
  socketIssues: [],
};

const uniform = (rng, a, b) => a + rng() * (b - a);

/** A seeded PRNG (mulberry32) so a run's timings can be replayed. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DriverBot {
  /**
   * @param {{ base: string, venue: any, driver: { id: string, phone: string, pin: string }, sim: any,
   *           rng: () => number, phoneOfTicket: Map<string,string>, log: (m: string) => void,
   *           opts: { acceptMinS: number, acceptMaxS: number, stepMinS: number, stepMaxS: number, driveMinS: number,
   *                   driveMaxS: number, reserveProbability: number, heartbeatS: number } }} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.api = new ApiClient(o.base, { label: `drv:${o.driver.phone.slice(-4)}` });
    this.socket = null;
    this.current = null; // { taskId, ticketId }
    this.next = null;
    this.pendingAccept = null; // offerId being accepted (timer or request)
    this.offers = new Map(); // live offers seen on the socket: offerId → card
    this.active = false; // reacting to offers (the burst)
    this.timers = new Set();
    this.done = 0;
    this.failures = [];
  }

  get id() {
    return this.driver.id;
  }

  async signIn() {
    await this.api.login(this.driver.phone, this.driver.pin);
    const d = await this.api.command('POST', '/v1/me/duty/start', {});
    if (d.status !== 201 && d.error?.code !== 'DUTY_ALREADY_STARTED')
      throw new Error(`${this.api.label}: duty start ${d.status} ${d.error?.code}`);
    this.socket = this.api.socket();
    this.listen();
    await connected(this.socket);
    const beat = setInterval(() => {
      if (this.socket?.connected)
        this.socket
          .timeout(10_000)
          .emitWithAck('client.heartbeat', {
            visible: true,
            audio_unlocked: true,
            last_event_id: null,
            app_version: 'load',
          })
          .catch(() => {});
    }, this.opts.heartbeatS * 1000);
    beat.unref();
    this.timers.add(beat);
  }

  listen() {
    const s = this.socket;
    const onOffer = (m) => {
      const card = m?.payload;
      if (!card?.offer_id) return;
      observed.offers.push({
        taskId: card.task_id,
        offerId: card.offer_id,
        userId: this.id,
        mode: card.mode,
        eligible: card.eligible_as,
        at: Date.now(),
      });
      this.offers.set(card.offer_id, card);
      this.consider();
    };
    s.on('task.offered', onOffer);
    s.on('task.broadcast', onOffer);
    s.on('offer.closed', (m) => this.offers.delete(m?.payload?.offer_id));
    s.on('task.claimed', (m) => {
      const p = m?.payload ?? {};
      observed.claimed.push({
        taskId: p.task_id,
        userId: this.id,
        winnerId: p.claimed_by?.id ?? null,
        at: Date.now(),
      });
      for (const id of p.offer_ids ?? []) this.offers.delete(id);
      for (const [id, card] of this.offers) if (card.task_id === p.task_id) this.offers.delete(id);
    });
    s.on('connect_error', (e) =>
      observed.socketIssues.push({
        user: this.id,
        kind: 'connect_error',
        code: e?.data?.code,
        at: Date.now(),
      }),
    );
    s.on('disconnect', (reason) =>
      observed.socketIssues.push({ user: this.id, kind: 'disconnect', reason, at: Date.now() }),
    );
  }

  /** Decides whether to accept (idle) or reserve (one movement, broadcast) one of the live offers seen. */
  consider() {
    if (!this.active || this.pendingAccept) return;
    const cards = [...this.offers.values()].sort(
      (a, b) => Date.parse(a.requested_at) - Date.parse(b.requested_at),
    );
    const idle = !this.current && !this.next;
    const card = idle
      ? cards.find((c) => c.can_accept || c.eligible_as === 'accept')
      : this.current && !this.next
        ? cards.find((c) => c.can_reserve_next || c.eligible_as === 'reserve_next')
        : null;
    if (!card) return;
    if (!idle && this.rng() >= this.opts.reserveProbability) {
      this.offers.delete(card.offer_id); // decided not to reserve this one
      return;
    }
    this.pendingAccept = card.offer_id;
    const t = setTimeout(
      () => {
        this.timers.delete(t);
        void this.accept(card);
      },
      uniform(this.rng, this.opts.acceptMinS, this.opts.acceptMaxS) * 1000,
    );
    this.timers.add(t);
  }

  async accept(card) {
    try {
      if (!this.offers.has(card.offer_id)) return; // closed or claimed meanwhile
      const r = await this.api.command('POST', `/v1/task-offers/${card.offer_id}/accept`, {});
      this.offers.delete(card.offer_id);
      if (r.status !== 200) return; // 409/410 are expected outcomes of a race (counted from the HTTP log)
      const task = r.data?.task;
      const ticketId = r.data?.ticket?.id ?? task?.ticket_id;
      if (task?.status === 'assigned_waiting') this.next = { taskId: task.id, ticketId };
      else {
        this.current = { taskId: task.id, ticketId };
        void this.run(this.current);
      }
    } finally {
      this.pendingAccept = null;
      this.consider();
    }
  }

  async step(min = this.opts.stepMinS, max = this.opts.stepMaxS) {
    await sleep(uniform(this.rng, min, max) * 1000);
  }

  /** The retrieval with compressed steps: key pickup, start, ready, the code from the customer, handover. */
  async run(job) {
    try {
      await this.step();
      const home = await this.api.get('/v1/me/home');
      const card = home.data?.current_task;
      if (!card || card.task?.id !== job.taskId) throw new Error(`home has no current task ${job.taskId}`);
      const slot = card.key_slot?.id;
      if (!slot) throw new Error(`task ${job.taskId} has no key slot`);
      await this.must(
        this.api.command('POST', `/v1/tasks/${job.taskId}/key-pickup`, { key_slot_id: slot }),
        'key-pickup',
      );
      await this.step();
      await this.must(
        this.api.command('POST', `/v1/tasks/${job.taskId}/start-retrieval`, {}),
        'start-retrieval',
      );
      await this.step(this.opts.driveMinS, this.opts.driveMaxS);
      await this.must(this.api.command('POST', `/v1/tasks/${job.taskId}/ready`, {}), 'ready');
      const phone = this.phoneOfTicket.get(job.ticketId);
      const code = await this.codeFor(phone);
      await this.step();
      const due = card.payment_due;
      const body = { verification: { method: 'code', code } };
      if (due?.amount_halalas > 0) body.payment = { method: 'cash', amount_halalas: due.amount_halalas };
      await this.must(this.api.command('POST', `/v1/tickets/${job.ticketId}/handover`, body), 'handover');
      this.done++;
    } catch (e) {
      this.failures.push({ taskId: job.taskId, error: e.message, at: Date.now() });
      this.log(`${this.api.label}: task ${job.taskId} failed: ${e.message}`);
    } finally {
      if (this.current?.taskId === job.taskId) this.current = null;
      await this.afterTask();
    }
  }

  /** What the app does after a command: refetch home (a promoted next task, the head offer). */
  async afterTask() {
    if (!this.active) return;
    const home = await this.api.get('/v1/me/home');
    const cur = home.data?.current_task;
    if (cur?.task?.id && cur.task.status === 'accepted') {
      this.next = null;
      this.current = { taskId: cur.task.id, ticketId: cur.ticket?.id };
      void this.run(this.current);
      return;
    }
    const offer = home.data?.offer;
    if (offer?.offer_id && !this.offers.has(offer.offer_id)) this.offers.set(offer.offer_id, offer);
    this.consider();
  }

  must(p, what) {
    return must(p, what);
  }

  /** The handover code as the customer reads it: the last W-05 the simulator delivered to his phone. */
  async codeFor(phone, timeoutMs = 90_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const code = await this.sim.claimCode(phone).catch(() => null);
      if (code) return code;
      await sleep(300);
    }
    throw new Error(`no W-05 code for ${phone.slice(-4)} within ${timeoutMs} ms`);
  }

  /** Prep (not measured): one WhatsApp ticket through intake, submit (W-01) and complete-parking. */
  async intake(t) {
    const r = await intakeAndPark(this.api, t);
    return { ticketId: r.ticketId, taskId: r.parkTaskId, phone: t.phone, venue: t.venue };
  }

  async stop() {
    this.active = false;
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
    this.socket?.close();
  }
}

export class SupervisorWatcher {
  constructor({ base, venue, log }) {
    this.venue = venue;
    this.log = log;
    this.api = new ApiClient(base, { label: `sup:${venue.code}` });
    this.socket = null;
  }

  async signIn() {
    await this.api.login(this.venue.supervisor.phone, this.venue.supervisor.password);
    this.socket = this.api.socket();
    this.socket.on('task.updated', (m) => {
      const p = m?.payload ?? {};
      const id = p.task?.id ?? p.id ?? p.task_id;
      if (id && !observed.firstTaskUpdate.has(id)) observed.firstTaskUpdate.set(id, Date.now());
    });
    // a supervisor socket that drops loses M1 observations: its issues count like a driver's
    const user = this.venue.supervisor.id;
    this.socket.on('connect_error', (e) =>
      observed.socketIssues.push({ user, kind: 'connect_error', code: e?.data?.code, at: Date.now() }),
    );
    this.socket.on('disconnect', (reason) =>
      observed.socketIssues.push({ user, kind: 'disconnect', reason, at: Date.now() }),
    );
    await connected(this.socket);
  }

  async stop() {
    this.socket?.close();
  }
}
