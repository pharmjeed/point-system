/**
 * Test cards of the simulator (DEC-510). Each number decides how a payment made with it (through its token) ends:
 * paid at once, 3-D Secure then paid, declined, or 3-D Secure then declined. The Visa numbers follow the test cards
 * published by Moyasar where they could be confirmed (4111…1111 approved, 4000…0002 requires 3-D Secure,
 * 4201320000311101 insufficient funds code 51, 4201320131000508 3-D Secure failed); the mada number is the
 * simulator's own (no Moyasar mada test number could be confirmed) and must not be assumed to work at Moyasar.
 */
export type CardBehaviour = 'success' | '3ds_success' | 'declined' | '3ds_declined';

export interface TestCard {
  number: string;
  company: 'visa' | 'master' | 'mada' | 'amex';
  behaviour: CardBehaviour;
  /** what the gateway puts in source.response_code / source.message */
  responseCode: string;
  message: string;
}

export const TEST_CARDS = {
  success: {
    number: '4111111111111111',
    company: 'visa',
    behaviour: 'success',
    responseCode: '00',
    message: 'APPROVED',
  },
  threeDs: {
    number: '4000000000000002',
    company: 'visa',
    behaviour: '3ds_success',
    responseCode: '00',
    message: 'APPROVED',
  },
  declined: {
    number: '4201320000311101',
    company: 'visa',
    behaviour: 'declined',
    responseCode: '51',
    message: 'INSUFFICIENT FUNDS',
  },
  threeDsDeclined: {
    number: '4201320131000508',
    company: 'visa',
    behaviour: '3ds_declined',
    responseCode: '05',
    message: '3-D Secure transaction attempt failed',
  },
  mada: {
    number: '4400000000000008',
    company: 'mada',
    behaviour: 'success',
    responseCode: '00',
    message: 'APPROVED',
  },
} satisfies Record<string, TestCard>;

export function cardByNumber(number: string): TestCard | null {
  const digits = number.replace(/[\s-]/g, '');
  return (Object.values(TEST_CARDS) as TestCard[]).find((c) => c.number === digits) ?? null;
}

/** Apple Pay tokens of the simulator: any string; `declined` in it declines, `3ds` in it challenges. */
export function applePayBehaviour(token: string): CardBehaviour {
  if (/declined/i.test(token)) return 'declined';
  if (/3ds/i.test(token)) return '3ds_success';
  return 'success';
}

/** `4111-11XX-XXXX-1111` — the masked number the gateway shows (first six and last four only). */
export function maskedNumber(number: string): string {
  const d = number.replace(/\D/g, '');
  return `${d.slice(0, 4)}-${d.slice(4, 6)}XX-XXXX-${d.slice(-4)}`;
}
