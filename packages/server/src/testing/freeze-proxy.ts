import net from 'node:net';

export interface FreezeProxy {
  /** 127.0.0.1 port the processes under test connect to instead of the database's */
  readonly port: number;
  readonly frozen: boolean;
  readonly stats: { connections: number; acceptedWhileFrozen: number; heldBytes: number };
  /** the same connection string, through the relay */
  via(connectionString: string): string;
  freeze(): void;
  thaw(): void;
  stop(): Promise<void>;
}

/**
 * Test helper (17 §12, DEC-PROPOSED-8): a TCP relay between the code under test and PostgreSQL that can freeze.
 * While frozen it accepts connections and bytes and answers nothing — what a client sees when the database
 * container is paused (`docker pause`: the kernel still completes handshakes and buffers data, the server never
 * answers) or a network link stalls. Thawing delivers what was held, in order, and resumes; a connection the
 * client closed meanwhile is dropped with its bytes. Used by the integration tests and by `pnpm ops:chaos`.
 */
export async function startFreezeProxy(
  target: { host: string; port: number },
  port = 0,
): Promise<FreezeProxy> {
  let frozen = false;
  const held: [net.Socket, Buffer][] = [];
  const waiting: net.Socket[] = [];
  const sockets = new Set<net.Socket>();
  const stats = { connections: 0, acceptedWhileFrozen: 0, heldBytes: 0 };

  const relay = (from: net.Socket, to: net.Socket) =>
    from.on('data', (chunk: Buffer) => {
      if (frozen) {
        held.push([to, chunk]);
        stats.heldBytes += chunk.length;
      } else if (!to.destroyed) to.write(chunk);
    });

  const link = (client: net.Socket) => {
    const up = net.connect(target.port, target.host);
    up.setNoDelay(true);
    sockets.add(up);
    relay(client, up);
    relay(up, client);
    const close = () => {
      client.destroy();
      up.destroy();
      sockets.delete(client);
      sockets.delete(up);
    };
    for (const s of [client, up]) {
      s.on('error', close);
      s.on('close', close);
    }
    client.resume();
  };

  const server = net.createServer((client) => {
    stats.connections++;
    client.setNoDelay(true);
    sockets.add(client);
    client.pause();
    if (frozen) {
      stats.acceptedWhileFrozen++;
      client.on('error', () => client.destroy());
      client.on('close', () => sockets.delete(client));
      waiting.push(client);
    } else link(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;

  return {
    port: bound,
    stats,
    get frozen() {
      return frozen;
    },
    via(connectionString: string) {
      const u = new URL(connectionString);
      u.hostname = '127.0.0.1';
      u.port = String(bound);
      return u.toString();
    },
    freeze() {
      frozen = true;
    },
    thaw() {
      frozen = false;
      for (const [to, chunk] of held.splice(0)) if (!to.destroyed) to.write(chunk);
      for (const c of waiting.splice(0)) if (!c.destroyed) link(c);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}
