#!/usr/bin/env bash
# A payment-simulator round trip on this server's staging stack (DEC-630, DEC-635), both directions, run from inside
# the api container (the simulator publishes no port):
#   api → simulator   the api's MOYASAR_SECRET_KEY is accepted by the simulator (and a wrong key is refused)
#   simulator → api   an event signed with MOYASAR_WEBHOOK_SECRET is accepted by /webhooks/payments/moyasar
#                     (and one with a wrong secret is refused)
# The test payment exists only in the simulator: nothing is charged. Prints statuses, never a key or a secret.
#   bash infra/deploy/smoke-payments.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC2016 # JavaScript, run by node inside the container
exec bash "$ROOT/infra/deploy/pc.sh" exec -T api node -e '
(async () => {
  const base = process.env.MOYASAR_BASE_URL;
  if (process.env.MOYASAR_MODE !== "simulator") throw new Error(`MOYASAR_MODE=${process.env.MOYASAR_MODE}: no simulator to test`);
  const basic = (key) => ({ authorization: "Basic " + Buffer.from(key + ":").toString("base64") });
  const post = (path, body) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => { if (!r.ok) throw new Error(`${path} → ${r.status}`); return r.json(); });
  const key = await fetch(base + "/v1/payments", { headers: basic(process.env.MOYASAR_SECRET_KEY) });
  const wrongKey = await fetch(base + "/v1/payments", { headers: basic("sk_test_not_the_key") });
  const p = await post("/_sim/payments", { amount: 1500, emit: false });
  const hook = await post(`/_sim/payments/${p.id}/webhook`, { type: "payment_paid" });
  const wrongHook = await post(`/_sim/payments/${p.id}/webhook`, { type: "payment_paid", secret: "not-the-secret" });
  console.log(`api → simulator: key ${key.status}, wrong key ${wrongKey.status} · simulator → api: event ${hook.status}, wrong secret ${wrongHook.status}`);
  if (key.status !== 200 || wrongKey.status !== 401 || hook.status !== 200 || !(wrongHook.status >= 400)) process.exit(1);
  console.log("payment simulator round trip: ok");
})().catch((e) => { console.error(`payment simulator round trip failed: ${e.message}`); process.exit(1); });
'
