import { maskPhone } from '@/lib/phone';

/**
 * Masked phone `05•••••123` in Mono, isolated LTR (03 §2.9). Accepts the server's `phone_masked` or a full
 * number (masked here). Full reveal is a supervisor action with a reason and an audit row (S-03).
 */
export function MaskedPhone({ phone }: { phone: string }) {
  return (
    <bdi dir="ltr" className="pt-masked">
      {maskPhone(phone)}
    </bdi>
  );
}
