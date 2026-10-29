// Child processes of a harness run (api, worker, simulator): started from their production build, logs to files,
// exits observed (a kill point ends a process with SIGKILL), CPU and memory read from /proc (Linux).
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOT, distPath } from './deps.mjs';
import { baseEnv } from './env.mjs';

export const SCRIPTS = {
  api: 'apps/api/dist/main.js',
  worker: 'apps/worker/dist/main.js',
  simulator: 'tools/wa-simulator/dist/main.js',
};

export class Proc {
  /**
   * @param {string} name label (also the log file name)
   * @param {string} script repository path of the entry point
   * @param {Record<string,string>} env the full environment (merged over baseEnv)
   * @param {string} logDir
   */
  constructor(name, script, env, logDir) {
    this.name = name;
    this.script = script;
    this.env = env;
    this.logDir = logDir;
    this.child = null;
    this.exit = null;
    this.killPoint = null;
    this.starts = 0;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  get running() {
    return !!this.child && this.exit === null;
  }

  start(extraEnv = {}) {
    if (this.running) throw new Error(`${this.name} is already running`);
    this.starts++;
    this.exit = null;
    this.killPoint = null;
    const log = createWriteStream(join(this.logDir, `${this.name}.log`), { flags: 'a' });
    log.write(
      `\n===== start #${this.starts} ${new Date().toISOString()} ${JSON.stringify(Object.keys(extraEnv))}\n`,
    );
    const child = spawn(process.execPath, [distPath(this.script)], {
      cwd: ROOT,
      env: { ...baseEnv(), ...this.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.pipe(log, { end: false });
    child.stderr.on('data', (chunk) => {
      log.write(chunk);
      const m = /"kill_point":"([a-z_]+)"/.exec(chunk.toString());
      if (m) this.killPoint = m[1];
    });
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        this.exit = { code, signal, at: Date.now() };
        log.end(`\n===== exit code=${code} signal=${signal} ${new Date().toISOString()}\n`);
        resolve(this.exit);
      });
    });
    return this;
  }

  /** Graceful stop (SIGTERM), then SIGKILL after `timeoutMs`. */
  async stop(timeoutMs = 15_000) {
    if (!this.running) return this.exit;
    this.child.kill('SIGTERM');
    const done = await Promise.race([this.exited, sleep(timeoutMs).then(() => null)]);
    if (done) return done;
    this.child.kill('SIGKILL');
    return this.exited;
  }

  /** The crash of a container runtime: SIGKILL now. */
  async kill9() {
    if (!this.running) return this.exit;
    this.child.kill('SIGKILL');
    return this.exited;
  }

  /** Waits for the process to end by itself (a kill point), up to `timeoutMs`. */
  async waitExit(timeoutMs) {
    return Promise.race([this.exited, sleep(timeoutMs).then(() => null)]);
  }

  /** utime + stime (clock ticks) and RSS bytes from /proc; null when unavailable. */
  usage() {
    if (!this.running) return null;
    try {
      const stat = readFileSync(`/proc/${this.pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // fields after the command: state(0) … utime(11) stime(12) … rss(21)
      return { ticks: Number(f[11]) + Number(f[12]), rssBytes: Number(f[21]) * 4096 };
    } catch {
      return null;
    }
  }
}

/** Polls `url` until it answers `status` (default 200). */
export async function waitHttp(url, { timeoutMs = 60_000, status = 200, intervalMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await r.arrayBuffer();
      if (r.status === status) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e?.cause?.code ?? e?.message ?? String(e);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${url} did not answer ${status} within ${timeoutMs} ms (${last})`);
}

/** Clock ticks per second of /proc/<pid>/stat (USER_HZ, 100 on Linux). */
export const CLK_TCK = 100;

/** Samples CPU % and RSS of processes every `everyMs` until stopped. */
export function sampleUsage(procs, everyMs = 2000) {
  const samples = [];
  const prev = new Map();
  const timer = setInterval(() => {
    const at = Date.now();
    for (const p of procs) {
      const u = p.usage();
      if (!u) continue;
      const before = prev.get(p.name);
      prev.set(p.name, { ...u, at, pid: p.pid });
      if (before && before.pid === p.pid) {
        const cpu = ((u.ticks - before.ticks) / CLK_TCK / ((at - before.at) / 1000)) * 100;
        samples.push({ at, proc: p.name, cpuPct: Math.max(0, cpu), rssMb: u.rssBytes / 1048576 });
      }
    }
  }, everyMs);
  timer.unref();
  return {
    samples,
    stop: () => clearInterval(timer),
  };
}
