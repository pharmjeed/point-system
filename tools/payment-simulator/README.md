# payment-simulator — the Moyasar API on your machine (dev / tests / CI only)

A local fake of the part of the Moyasar REST API the server uses (V2-020, DEC-510), a webhook emitter that sends the
gateway's events with the endpoint's shared secret, and test cards. The server's Moyasar adapter talks to it exactly
as it would to `https://api.moyasar.com` when `MOYASAR_MODE=simulator` and `MOYASAR_BASE_URL` points here.

It **refuses to start** with `APP_ENV=production` or `NODE_ENV=production`, and it refuses any live key
(`sk_live_…` / `pk_live_…`). No card is ever charged through it.

## Run

```bash
pnpm --filter @point/payment-simulator dev        # part of `pnpm dev` (port 4020)
```

| Variable                                     | Default                                       | Meaning                                     |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| `PORT` / `HOST`                              | `4020` / `0.0.0.0`                            | listen address (`MOYASAR_BASE_URL`)         |
| `WEBHOOK_URL`                                | —                                             | the API's `/webhooks/payments/moyasar`      |
| `SECRET_KEY` (or `MOYASAR_SECRET_KEY`)       | `sk_test_point_simulator_secret`              | the only secret key accepted (HTTP Basic)   |
| `PUBLISHABLE_KEY`                            | `pk_test_point_simulator_publishable`         | tokenization, as from the customer's device |
| `WEBHOOK_SECRET` (or `MOYASAR_WEBHOOK_SECRET`) | `point-simulator-webhook-secret`            | sent as `secret_token` in every event       |
| `WEBHOOK_RETRIES` / `PAGE_SIZE`              | `0` / `20`                                    | retries on a non-2xx answer; list page size |

## The fake API (`/v1/*`, HTTP Basic: the key as user name, empty password)

- `POST /v1/tokens` (publishable key): a test card number → `token_…`.
- `POST /v1/payments` (secret key): `amount` in halalas (≥ 100), `currency` SAR, `callback_url` (required),
  `given_id` (UUID, idempotent), `metadata`, `source` `{ type: 'token', token }` or `{ type: 'applepay', token }`.
  A `creditcard` source is refused with the secret key, as Moyasar forbids card data from a backend.
- `GET /v1/payments/{id}`, `GET /v1/payments?page&created[gte]&created[lte]&status` (`{ payments, meta }`).
- `POST /v1/payments/{id}/refund` (`amount` optional): a partial refund keeps the payment `paid` with `refunded` set;
  the whole amount makes it `refunded`.

## Test cards

| Card                | Number             | Outcome                                       |
| ------------------- | ------------------ | --------------------------------------------- |
| `success`           | `4111111111111111` | paid at once                                  |
| `threeDs`           | `4000000000000002` | `initiated` + 3-D Secure page, then paid      |
| `declined`          | `4201320000311101` | failed, response code 51 (insufficient funds) |
| `threeDsDeclined`   | `4201320131000508` | 3-D Secure, then failed                       |
| `mada` (simulator's own number) | `4400000000000008` | paid at once (company `mada`)     |

Apple Pay: any token string; `declined` in it declines, `3ds` in it challenges.

## Controls (`/_sim/*`, no authentication — local only)

`PATCH /_sim/config`, `POST /_sim/reset`, `GET /_sim/payments[/{id}]`, `POST /_sim/payments` (a payment the platform
never made), `POST /_sim/payments/{id}/3ds` (`outcome`), `POST /_sim/payments/{id}/mutate` (status/amount/refunded),
`POST /_sim/payments/{id}/webhook` (`type`, `status`, `deliver: false` to only get the body, `secret`),
`GET /_sim/webhooks`, `POST /_sim/webhooks/flush`, `POST /_sim/webhooks/replay`. The 3-D Secure page itself is
`/sim/3ds/{id}` (two buttons, then a redirect to the callback URL — which changes nothing on the server).
`PaymentSimulatorClient` wraps them for the tests (`apps/api/test/payments-online.int.test.ts`).
