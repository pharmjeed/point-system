/**
 * Card tokenization on the device (V2-022 / V2-023, DEC-524): the card goes from this function to Moyasar only —
 * `POST {baseUrl}/v1/tokens` with the **publishable** key (HTTP Basic, the key as user name), `save_only: true`, the
 * payload of Moyasar's own React Native SDK (`react-native-moyasar-sdk` 0.15.0, `createToken`/`TokenRequest`). The
 * server receives the token alone and creates the payment itself with the amount it decides (DEC-510, DEC-521);
 * the SDK's payment and Apple Pay components create payments from the device with the app's amount, so they are not
 * used. In fake mode the in-app fake tokenizes locally (same token rules as the simulator's test cards).
 *
 * Nothing here logs: no card field ever reaches a log, an error message or the app's state after the call.
 */
import { fakeTokenize } from '../../api/fake/tokens';
import type { AppConfig } from '../../configModel';
import type { CardFields } from './card';

export class TokenizeError extends Error {
  constructor(
    /** `unavailable`: no publishable key configured; `declined`: Moyasar refused the card; `network`: unreachable */
    readonly kind: 'unavailable' | 'declined' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'TokenizeError';
  }
}

export interface CardToken {
  token: string;
  /** Moyasar's 3-D Secure verification page of the token, when it asks for one before it can be charged */
  verificationUrl: string | null;
}

export type CardTokenizer = (card: CardFields) => Promise<CardToken>;

export function createCardTokenizer(
  config: Pick<AppConfig, 'api' | 'payments'>,
  opts: { fetchImpl?: typeof fetch; callbackUrl: string; btoa?: (s: string) => string } = {
    callbackUrl: 'sa.point.app://pay/return',
  },
): CardTokenizer {
  if (config.api.mode === 'fake')
    return async (card) => ({ token: fakeTokenize(card), verificationUrl: null });
  const key = config.payments.moyasarPublishableKey;
  const doFetch = opts.fetchImpl ?? fetch;
  const encode = opts.btoa ?? ((s: string) => globalThis.btoa(s));
  return async (card) => {
    if (!key) throw new TokenizeError('unavailable', 'card payments are not configured');
    let res: Response;
    try {
      res = await doFetch(`${config.payments.moyasarBaseUrl}/v1/tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Basic ${encode(`${key}:`)}`,
        },
        body: JSON.stringify({
          name: card.name,
          number: card.number,
          cvc: card.cvc,
          month: String(card.month).padStart(2, '0'),
          year: String(card.year),
          save_only: true,
          callback_url: opts.callbackUrl,
        }),
      });
    } catch {
      throw new TokenizeError('network', 'tokenization unreachable');
    }
    let body: { id?: unknown; status?: unknown; verification_url?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = {};
    }
    if (!res.ok || typeof body.id !== 'string')
      throw new TokenizeError(
        res.status >= 500 ? 'network' : 'declined',
        `tokenization refused (${res.status})`,
      );
    return {
      token: body.id,
      verificationUrl: typeof body.verification_url === 'string' ? body.verification_url : null,
    };
  };
}
