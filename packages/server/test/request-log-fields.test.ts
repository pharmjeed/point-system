import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { requestLogFields, type PipelineRequest } from '../src/http/middleware.js';

const req = (o: Partial<PipelineRequest> & { route?: { path: string } }) =>
  ({ method: 'POST', baseUrl: '', ...o }) as unknown as PipelineRequest;

/** 05 §7.6: every request log line carries request_id, user_id, role, venue_id, route, status, duration_ms. */
describe('requestLogFields', () => {
  it('carries the seven fields of 05 §7.6 with the canon route template, never an id', () => {
    const f = requestLogFields(
      req({
        requestId: 'req_1',
        startedAt: performance.now() - 25,
        route: { path: '/v1/tickets/:ticketId/submit-intake' },
        actor: { userId: 'u-1', role: 'driver', venueId: 'v-1' },
      }),
      200,
    );
    expect(Object.keys(f).sort()).toEqual(
      ['duration_ms', 'request_id', 'role', 'route', 'status', 'user_id', 'venue_id'].sort(),
    );
    expect(f).toMatchObject({
      request_id: 'req_1',
      user_id: 'u-1',
      role: 'driver',
      venue_id: 'v-1',
      route: 'POST /v1/tickets/{ticketId}/submit-intake',
      status: 200,
    });
    expect(f.duration_ms).toBeGreaterThanOrEqual(24);
  });

  it('an anonymous request on no route: the fields stay, empty where nothing is known', () => {
    const f = requestLogFields(req({ requestId: 'req_2' }), 404);
    expect(f).toEqual({
      request_id: 'req_2',
      user_id: undefined,
      role: undefined,
      venue_id: undefined,
      route: 'unmatched',
      status: 404,
      duration_ms: undefined,
    });
  });
});
