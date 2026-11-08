import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SimulatorClient } from './client.js';
import { assertNotProduction, type SimulatorOptions } from './config.js';
import { controlRouter, type ControlContext } from './control-api.js';
import {
  handleCreateTemplate,
  handleListTemplates,
  handlePhoneNumber,
  handleSendMessage,
  type GraphContext,
} from './graph-api.js';
import { HttpAnswer, HttpError, parseJson, readRawBody, Router, sendJson, sendText } from './http-util.js';
import { SimulatorState } from './store.js';
import { renderUi } from './ui.js';

function graphRouter(): Router<GraphContext> {
  return new Router<GraphContext>()
    .on('POST', '/:version/:phoneNumberId/messages', handleSendMessage)
    .on('GET', '/:version/:id/message_templates', handleListTemplates)
    .on('POST', '/:version/:id/message_templates', handleCreateTemplate)
    .on('GET', '/:version/:id', handlePhoneNumber);
}

export interface SimulatorServer {
  server: Server;
  state: SimulatorState;
}

/** Builds the HTTP server (not listening yet). Refuses to run in production. */
export function createSimulatorServer(opts: SimulatorOptions = {}): SimulatorServer {
  assertNotProduction(opts.env ?? process.env);
  const { port: _port, host: _host, env: _env, logger, ...config } = opts;
  const state = new SimulatorState(config, logger);
  const control = controlRouter();
  const graph = graphRouter();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://wa-simulator.local');
    const method = (req.method ?? 'GET').toUpperCase();
    const raw = await readRawBody(req);
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendText(res, 200, renderUi(), 'text/html');
    }
    if (url.pathname.startsWith('/_sim/') || url.pathname.startsWith('/sim/')) {
      const found = control.match(method, url.pathname);
      if (!found) throw new HttpError(404, 'not_found', `no control route ${method} ${url.pathname}`);
      if ('allowed' in found)
        throw new HttpError(405, 'method_not_allowed', `allowed: ${found.allowed.join(', ')}`);
      const ctx: ControlContext = { req, res, state, url, body: parseJson(raw) };
      return found.route.handler(ctx, found.params);
    }
    const found = graph.match(method, url.pathname);
    if (!found || 'allowed' in found) {
      return sendJson(res, found ? 405 : 404, {
        error: {
          message: `Unknown path components: ${url.pathname}`,
          type: 'OAuthException',
          code: 2500,
          fbtrace_id: 'SIM',
        },
      });
    }
    return found.route.handler({ req, res, state, url, raw }, found.params);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpAnswer) return sendJson(res, err.status, err.body);
      if (err instanceof HttpError)
        return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      state.log(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      sendJson(res, 500, { error: { code: 'internal_error', message: 'simulator internal error' } });
    });
  });
  server.on('close', () => state.cancelTimers());
  return { server, state };
}

export interface RunningSimulator {
  /** Base URL, e.g. http://127.0.0.1:4010 — use it as WA_GRAPH_BASE_URL. */
  url: string;
  port: number;
  client: SimulatorClient;
  /** In-memory state (advanced use in tests). */
  state: SimulatorState;
  close(): Promise<void>;
}

/** Starts the simulator in-process (API integration tests run it without Docker). Port 0 = a free port. */
export async function startSimulator(opts: SimulatorOptions = {}): Promise<RunningSimulator> {
  const host = opts.host ?? '127.0.0.1';
  const { server, state } = createSimulatorServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const publicHost =
    host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${publicHost}:${port}`;
  let closed: Promise<void> | null = null;
  return {
    url,
    port,
    state,
    client: new SimulatorClient(url),
    close() {
      closed ??= new Promise<void>((resolve) => {
        state.cancelTimers();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
