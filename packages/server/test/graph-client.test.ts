import { describe, expect, it } from 'vitest';
import { GraphClient, PHONE_NUMBER_FIELDS } from '../src/modules/whatsapp/infra/graph-client.js';

const CH = {
  api_version: 'v26.0',
  phone_number_id: '123456789012345',
  business_account_id: '200000000000001',
};
const BASE = 'https://graph.example';

/** A fetch that answers each call with the next canned response and records the URLs. */
function cannedFetch(...answers: { status: number; body: unknown }[]) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    const a = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { urls, fetchImpl };
}

/**
 * GET /{phone_number_id} (12 §3.1, §5.14; GAP-9): the Graph API returns a field outside the node's default set only
 * when `fields` names it — the messaging limit and the health status among them.
 */
describe('GraphClient.phoneNumber', () => {
  it('names the quality rating, the health status and the messaging limit in `fields`', async () => {
    const { urls, fetchImpl } = cannedFetch({
      status: 200,
      body: {
        id: CH.phone_number_id,
        quality_rating: 'GREEN',
        whatsapp_business_manager_messaging_limit: 'TIER_2K',
      },
    });
    const client = new GraphClient({ baseUrl: BASE, timeoutMs: 1000, fetch: fetchImpl });
    const r = await client.phoneNumber(CH, 'token');
    expect(PHONE_NUMBER_FIELDS).toEqual([
      'quality_rating',
      'health_status',
      'whatsapp_business_manager_messaging_limit',
    ]);
    expect(urls).toEqual([
      `${BASE}/v26.0/${CH.phone_number_id}?fields=quality_rating,health_status,whatsapp_business_manager_messaging_limit`,
    ]);
    expect(r).toMatchObject({ ok: true, body: { whatsapp_business_manager_messaging_limit: 'TIER_2K' } });
  });

  it('reads the number without `fields` when the pinned version refuses one of them (#100)', async () => {
    const { urls, fetchImpl } = cannedFetch(
      {
        status: 400,
        body: { error: { code: 100, message: '(#100) Tried accessing nonexisting field (health_status)' } },
      },
      { status: 200, body: { id: CH.phone_number_id, quality_rating: 'GREEN' } },
    );
    const client = new GraphClient({ baseUrl: BASE, timeoutMs: 1000, fetch: fetchImpl });
    const r = await client.phoneNumber(CH, 'token');
    expect(urls).toEqual([
      `${BASE}/v26.0/${CH.phone_number_id}?fields=${PHONE_NUMBER_FIELDS.join(',')}`,
      `${BASE}/v26.0/${CH.phone_number_id}`,
    ]);
    expect(r).toMatchObject({ ok: true, body: { quality_rating: 'GREEN' } });
  });

  it('any other failure is returned as it is, without a second call', async () => {
    const { urls, fetchImpl } = cannedFetch({
      status: 401,
      body: { error: { code: 190, message: 'Error validating access token' } },
    });
    const client = new GraphClient({ baseUrl: BASE, timeoutMs: 1000, fetch: fetchImpl });
    const r = await client.phoneNumber(CH, 'token');
    expect(urls).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 401, code: 190 });
  });
});
