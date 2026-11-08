// `pnpm dev`: api + worker + web + wa-simulator with rebuild on change (05 §18.1).
// Backend packages are compiled by tsc in watch mode and the processes restart with `node --watch`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const env = { ...process.env, FORCE_COLOR: '1' };
const envFile = existsSync('.env') ? ['--env-file=.env'] : [];
if (!envFile.length)
  console.warn('[dev] no .env file: copy .env.example to .env and fill the local secrets (05 §18.1)');

const build = spawnSync(
  'pnpm',
  [
    '--filter',
    '@point/shared',
    '--filter',
    '@point/db',
    '--filter',
    '@point/server',
    '--filter',
    '@point/api',
    '--filter',
    '@point/worker',
    'build',
  ],
  {
    stdio: 'inherit',
    env,
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const procs = [
  [
    'shared',
    'pnpm',
    [
      '--filter',
      '@point/shared',
      'exec',
      'tsc',
      '-p',
      'tsconfig.build.json',
      '--watch',
      '--preserveWatchOutput',
    ],
  ],
  [
    'server',
    'pnpm',
    [
      '--filter',
      '@point/server',
      'exec',
      'tsc',
      '-p',
      'tsconfig.build.json',
      '--watch',
      '--preserveWatchOutput',
    ],
  ],
  [
    'api:tsc',
    'pnpm',
    [
      '--filter',
      '@point/api',
      'exec',
      'tsc',
      '-p',
      'tsconfig.build.json',
      '--watch',
      '--preserveWatchOutput',
    ],
  ],
  [
    'worker:tsc',
    'pnpm',
    [
      '--filter',
      '@point/worker',
      'exec',
      'tsc',
      '-p',
      'tsconfig.build.json',
      '--watch',
      '--preserveWatchOutput',
    ],
  ],
  [
    'api',
    'node',
    [
      ...envFile,
      '--watch',
      '--watch-path=apps/api/dist',
      '--watch-path=packages/server/dist',
      'apps/api/dist/main.js',
    ],
  ],
  [
    'worker',
    'node',
    [
      ...envFile,
      '--watch',
      '--watch-path=apps/worker/dist',
      '--watch-path=packages/server/dist',
      'apps/worker/dist/main.js',
    ],
  ],
  ['web', 'pnpm', ['--filter', '@point/web', 'dev']],
  ['wa-sim', 'pnpm', ['--filter', '@point/wa-simulator', 'dev']],
];

const children = procs.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `[${name}]`.padEnd(12);
  const pipe = (stream, out) =>
    stream.on('data', (d) => out.write(String(d).replace(/^(?=.)/gm, prefix + ' ')));
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${prefix} exited with ${code}`));
  return child;
});

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
