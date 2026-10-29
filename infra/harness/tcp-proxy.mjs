// A TCP relay between the processes under test and PostgreSQL that can freeze: while frozen it accepts connections
// and bytes and answers nothing — what a client sees when the database container is paused (`docker pause`: the
// kernel still completes handshakes and buffers data, the server never answers) or a network link stalls. Thawing
// delivers what was held, in order, and resumes. Only the processes started with the proxy's URL go through it; the
// harness keeps its own direct connections to inspect the database meanwhile.
import net from 'node:net';

/**
 * @param {{ port: number, targetHost: string, targetPort: number }} o
 */
export function freezableProxy(o) {
  let frozen = false;
  let server = null;
  /** [destination, chunk] in arrival order: what the frozen side would have read later */
  const held = [];
  /** client sockets accepted while frozen, linked upstream at the thaw */
  const waiting = [];
  const sockets = new Set();
  const stats = { connections: 0, acceptedWhileFrozen: 0, heldBytes: 0 };

  const relay = (from, to) =>
    from.on('data', (chunk) => {
      if (frozen) {
        held.push([to, chunk]);
        stats.heldBytes += chunk.length;
      } else if (!to.destroyed) to.write(chunk);
    });

  const link = (client) => {
    const up = net.connect(o.targetPort, o.targetHost);
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

  return {
    stats,
    get frozen() {
      return frozen;
    },
    start: () =>
      new Promise((resolve, reject) => {
        server = net.createServer((client) => {
          stats.connections++;
          client.setNoDelay(true);
          sockets.add(client);
          client.pause();
          if (frozen) {
            stats.acceptedWhileFrozen++;
            client.on('error', () => client.destroy());
            waiting.push(client);
          } else link(client);
        });
        server.once('error', reject);
        server.listen(o.port, '127.0.0.1', () => resolve());
      }),
    freeze() {
      frozen = true;
    },
    thaw() {
      frozen = false;
      for (const [to, chunk] of held.splice(0)) if (!to.destroyed) to.write(chunk);
      for (const c of waiting.splice(0)) if (!c.destroyed) link(c);
    },
    stop: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
      }),
  };
}
