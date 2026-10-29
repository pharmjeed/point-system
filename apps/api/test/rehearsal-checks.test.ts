import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM tooling of the rehearsal (apps/api/rehearsal), no type declarations
import * as checks from '../rehearsal/checks.mjs';
import { INVARIANTS } from './dispatch-fixtures.js';

/**
 * PNT-102: the automated rehearsal checks the same 10 §14.1 / 11 §1.7 consistency queries as the integration
 * tests, and its report helpers are plain functions.
 */
describe('rehearsal checks (apps/api/rehearsal/checks.mjs)', () => {
  it('runs exactly the INVARIANTS of the integration tests (no drift between the two copies)', () => {
    expect(checks.INVARIANT_QUERIES).toEqual(INVARIANTS);
  });

  it('covers the closed-event, duration and consistency queries it reports', () => {
    expect(Object.keys(checks.CLOSED_EVENT_CHECKS)).toEqual(
      expect.arrayContaining([
        'tickets not delivered or voided',
        'cash not handed over',
        'live handover code',
      ]),
    );
    for (const sql of Object.values(checks.DURATION_QUERIES) as string[]) expect(sql).toContain('$1');
  });

  it('percentile is the nearest rank and ignores non-numbers', () => {
    const xs = [5, 1, 4, 2, 3, Number.NaN];
    expect(checks.percentile(xs, 50)).toBe(3);
    expect(checks.percentile(xs, 95)).toBe(5);
    expect(checks.percentile(xs, 100)).toBe(5);
    expect(checks.percentile([], 50)).toBeNull();
    expect(checks.percentile([7], 1)).toBe(7);
  });

  it('reads a histogram of the /metrics text and bounds its percentiles by the buckets (M1, 05 §12.2)', () => {
    const text = [
      '# HELP point_retrieval_request_ingest_seconds Webhook button press to committed retrieval cycle',
      '# TYPE point_retrieval_request_ingest_seconds histogram',
      'point_retrieval_request_ingest_seconds_bucket{le="0.005"} 1',
      'point_retrieval_request_ingest_seconds_bucket{le="0.01"} 1',
      'point_retrieval_request_ingest_seconds_bucket{le="0.1"} 18',
      'point_retrieval_request_ingest_seconds_bucket{le="1"} 20',
      'point_retrieval_request_ingest_seconds_bucket{le="+Inf"} 20',
      'point_retrieval_request_ingest_seconds_sum 1.25',
      'point_retrieval_request_ingest_seconds_count 20',
      'point_other_seconds_bucket{le="0.1"} 99',
      'point_other_seconds_count 99',
    ].join('\n');
    const h = checks.promHistogram(text, 'point_retrieval_request_ingest_seconds');
    expect(h).toEqual({
      buckets: [
        { le: 0.005, count: 1 },
        { le: 0.01, count: 1 },
        { le: 0.1, count: 18 },
        { le: 1, count: 20 },
        { le: Infinity, count: 20 },
      ],
      sum: 1.25,
      count: 20,
    });
    expect(checks.bucketQuantile(h, 5)).toBe(0.005);
    expect(checks.bucketQuantile(h, 50)).toBe(0.1);
    expect(checks.bucketQuantile(h, 90)).toBe(0.1);
    expect(checks.bucketQuantile(h, 95)).toBe(1);
    expect(checks.bucketQuantile(checks.promHistogram('', 'x'), 95)).toBeNull();
  });

  it('formats seconds, riyals, tables and routes for the report', () => {
    expect(checks.secs(1.26)).toBe('1.3 s');
    expect(checks.secs(null)).toBe('—');
    expect(checks.sar(123456)).toBe('1,234.56 SAR');
    expect(checks.table(['a', 'b'], [[1, 'x|y']])).toBe('| a | b |\n|---|---|\n| 1 | x\\|y |');
    expect(checks.routeOf('/v1/tickets/0190b4a0-1c2d-7e3f-8a9b-0c1d2e3f4a5b/handover?x=1')).toBe(
      '/v1/tickets/{id}/handover',
    );
  });
});
