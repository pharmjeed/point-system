/**
 * Card tokens of the in-app fake (V2-022 / V2-023): what Moyasar's `POST /v1/tokens` does on the device, without a
 * network. The card number never leaves this function: the token keeps only the behaviour of the simulator's test
 * cards (tools/payment-simulator: success, 3-D Secure, declined), the last four digits and the expiry, never 13
 * digits in a row (the server refuses anything that could be a card number).
 */
export type FakeCardBehaviour = 'ok' | 'tds' | 'dec' | 'tdd';

const BEHAVIOUR: Readonly<Record<string, FakeCardBehaviour>> = {
  '4111111111111111': 'ok',
  '4000000000000002': 'tds',
  '4201320000311101': 'dec',
  '4201320131000508': 'tdd',
  '4400000000000008': 'ok',
};

export interface FakeTokenInfo {
  behaviour: FakeCardBehaviour;
  brand: string;
  last4: string;
  month: number;
  year: number;
}

function brandOf(number: string): string {
  if (number.startsWith('4400')) return 'mada';
  if (number.startsWith('4')) return 'visa';
  if (/^5[1-5]/.test(number) || /^2[2-7]/.test(number)) return 'master';
  if (/^3[47]/.test(number)) return 'amex';
  return 'visa';
}

export function fakeTokenize(
  card: { number: string; month: number; year: number },
  random: () => number = Math.random,
): string {
  const digits = card.number.replace(/\D/g, '');
  const b = BEHAVIOUR[digits] ?? 'ok';
  const rand = Array.from({ length: 12 }, () => 'abcdefghjkmnpqrstuvwxyz'[Math.floor(random() * 23)]).join(
    '',
  );
  const mm = String(card.month).padStart(2, '0');
  const yy = String(card.year % 100).padStart(2, '0');
  const brand = brandOf(digits);
  return `token_fk_${b}_${brand}_${digits.slice(-4)}_${mm}${yy}_${rand}`;
}

export function parseFakeToken(token: string): FakeTokenInfo | null {
  const m = /^token_fk_(ok|tds|dec|tdd)_([a-z]+)_([0-9]{4})_([0-9]{2})([0-9]{2})_[a-z]+$/.exec(token);
  if (!m) return null;
  return {
    behaviour: m[1] as FakeCardBehaviour,
    brand: m[2] as string,
    last4: m[3] as string,
    month: Number(m[4]),
    year: 2000 + Number(m[5]),
  };
}
