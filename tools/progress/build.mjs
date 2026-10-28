// Builds docs/progress/tickets.json from docs/16 and docs/progress/state.json.
// state.json maps ticket id -> { status: "done"|"in_progress"|"deferred", note?, date? }.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const plan = readFileSync(resolve(root, 'docs/16_Dev_Tickets_Sprint_Plan.md'), 'utf8').split('\n');
const statePath = resolve(root, 'docs/progress/state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const SPRINTS = [
  ['S0', 1, 10, null], ['S1', 11, 23, null], ['S2', 24, 36, 'G1'], ['S3', 37, 51, 'G2'],
  ['S4', 52, 63, null], ['S5', 64, 73, 'G3'], ['S6', 74, 85, null], ['S7', 86, 93, 'G4'], ['S8', 94, 103, 'G5'],
];
const STATUS_AR = { done: 'منجز', in_progress: 'قيد التنفيذ', todo: 'لم يبدأ', deferred: 'مؤجل' };
const sprintOf = (n) => SPRINTS.find(([, a, b]) => n >= a && n <= b);
const rows = [];
for (let i = 0; i < plan.length; i++) {
  const m = plan[i].match(/^#### (PNT-(\d{3})) — (.*)$/);
  if (!m) continue;
  const meta = plan[i + 1] ?? '';
  const size = (meta.match(/الحجم: ([SML])/) ?? [])[1] ?? 'M';
  const epic = (meta.match(/(EP-\d+)/) ?? [])[1] ?? '';
  const n = Number(m[2]);
  const [sprint, , , gate] = sprintOf(n);
  const s = state[m[1]] ?? {};
  rows.push({
    ticket: m[1], n, sprint, gate: gate && n === SPRINTS.find(([x]) => x === sprint)[2] ? gate : '',
    title: m[3].replace(/`/g, ''), epic, size, weight: { S: 1, M: 2, L: 3 }[size],
    status: s.status ?? 'todo', status_ar: STATUS_AR[s.status ?? 'todo'], date: s.date ?? '', note: s.note ?? '',
  });
}
writeFileSync(resolve(root, 'docs/progress/tickets.json'), JSON.stringify(rows, null, 1) + '\n');
const done = rows.filter((r) => r.status === 'done').length;
console.log(`${rows.length} tickets, ${done} done`);
