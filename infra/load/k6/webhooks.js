// k6 — the customer side of the load profile (17 H-08 phase 2, PNT-097): the «request the car» button presses as
// Meta delivers them, signed webhooks POSTed to /webhooks/whatsapp on a fixed schedule (uniform with two short
// bursts). The plan (built by infra/load/run.mjs, or by hand for another environment) holds the exact raw bodies;
// this script only waits for each press's time, signs the raw bytes with the app secret and posts them.
//
//   k6 run -e PLAN=plan.json -e SUMMARY_OUT=k6-summary.json infra/load/k6/webhooks.js
//
// plan.json: { "apiBase": "https://app.example", "appSecret": "…", "startAt": <epoch ms>, "durationS": 60,
//              "presses": [ { "at_ms": 0, "venue": "RMS", "raw": "{…webhook body…}" }, … ] }
/* global open, __ENV */
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const plan = JSON.parse(open(__ENV.PLAN));

const ack = new Trend('webhook_ack_ms', true);
const lateness = new Trend('press_lateness_ms', true);
const server5xx = new Counter('webhook_5xx');
const notOk = new Counter('webhook_not_200');

export const options = {
  scenarios: {
    presses: {
      executor: 'shared-iterations',
      vus: Math.max(1, Math.min(plan.presses.length, 200)),
      iterations: plan.presses.length,
      maxDuration: `${Math.ceil((plan.startAt - Date.now()) / 1000 + plan.durationS + 120)}s`,
    },
  },
  // AC-13 / 17 TC-039 on the webhook leg: errors under 0.1 %, the acknowledgement well under the 2 s budget
  thresholds: {
    http_req_failed: ['rate<0.001'],
    webhook_ack_ms: ['p(95)<2000'],
  },
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max', 'count'],
  discardResponseBodies: true,
};

export default function () {
  const i = exec.scenario.iterationInTest;
  const p = plan.presses[i];
  const due = plan.startAt + p.at_ms;
  const wait = (due - Date.now()) / 1000;
  if (wait > 0) sleep(wait);
  lateness.add(Math.max(0, Date.now() - due));
  const signature = `sha256=${crypto.hmac('sha256', plan.appSecret, p.raw, 'hex')}`;
  const res = http.post(`${plan.apiBase}/webhooks/whatsapp`, p.raw, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'facebookexternalua',
      'X-Hub-Signature-256': signature,
    },
    tags: { venue: p.venue, name: 'POST /webhooks/whatsapp' },
    timeout: '30s',
  });
  ack.add(res.timings.duration);
  if (res.status >= 500 || res.status === 0) server5xx.add(1);
  if (res.status !== 200) notOk.add(1);
  check(res, { 'webhook acknowledged 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  const out = {};
  if (__ENV.SUMMARY_OUT) out[__ENV.SUMMARY_OUT] = JSON.stringify(data, null, 2);
  const m = data.metrics;
  const v = (name, stat) => (m[name] && m[name].values[stat] !== undefined ? m[name].values[stat] : null);
  out.stdout =
    `k6 presses: ${v('http_reqs', 'count')} requests, failed rate ${v('http_req_failed', 'rate')}, ` +
    `ack p95 ${v('webhook_ack_ms', 'p(95)')} ms, max ${v('webhook_ack_ms', 'max')} ms, ` +
    `lateness p95 ${v('press_lateness_ms', 'p(95)')} ms\n`;
  return out;
}
