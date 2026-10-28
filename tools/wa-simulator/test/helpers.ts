import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWebhookSignature } from '../src/signature.js';

export const SECRET = 'test-app-secret';
export const VERIFY_TOKEN = 'test-verify-token';
export const TOKEN = 'test-access-token';

export interface Received {
  raw: string;
  headers: IncomingHttpHeaders;
  json: any;
  signatureValid: boolean;
}

/** A stand-in for the API's POST/GET /webhooks/whatsapp that records raw bodies and checks signatures. */
export async function startReceiver(secret = SECRET) {
  const received: Received[] = [];
  let statuses: number[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET') {
      const ok =
        url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === VERIFY_TOKEN;
      res.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' });
      res.end(ok ? (url.searchParams.get('hub.challenge') ?? '') : 'WA_WEBHOOK_VERIFY_FAILED');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        raw,
        headers: req.headers,
        json: JSON.parse(raw),
        signatureValid: verifyWebhookSignature(
          secret,
          raw,
          req.headers['x-hub-signature-256'] as string | undefined,
        ),
      });
      const status = statuses.shift() ?? 200;
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhooks/whatsapp`,
    received,
    /** Answer the next requests with these HTTP statuses (then 200). */
    failNext(...codes: number[]) {
      statuses = codes;
    },
    clear() {
      received.length = 0;
    },
    async waitFor(count: number, timeoutMs = 3000): Promise<Received[]> {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} webhooks, got ${received.length}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return received;
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

export type Receiver = Awaited<ReturnType<typeof startReceiver>>;

export function value(r: Received): any {
  return r.json.entry[0].changes[0].value;
}

/** POST /{version}/{phone_number_id}/messages the way the API's WaSender does. */
export async function graphSend(
  baseUrl: string,
  body: unknown,
  opts: {
    token?: string | null;
    headers?: Record<string, string>;
    phoneNumberId?: string;
    version?: string;
  } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  const res = await fetch(
    `${baseUrl}/${opts.version ?? 'v26.0'}/${opts.phoneNumberId ?? '123456789012345'}/messages`,
    {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
  return { status: res.status, json: (await res.json()) as any };
}

export function w01(to: string, ticket = '125', token = 'rq1.q8Zt3mVx0bW7nK2pLs9dEw', venue = 'قاعة ريماس') {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: 'masaf_ticket_issued_v1',
      language: { code: 'ar' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: venue },
            { type: 'text', text: ticket },
            { type: 'text', text: 'تويوتا كامري بيضاء — لوحة 4821' },
          ],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: token }],
        },
      ],
    },
    biz_opaque_callback_data: `wam:${ticket}`,
  };
}

export function w05(to: string, ticket = '125', code = '482731') {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: 'masaf_vehicle_ready_v1',
      language: { code: 'ar' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: ticket },
            { type: 'text', text: code },
          ],
        },
      ],
    },
  };
}

export function sessionText(to: string, body: string) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
  };
}
