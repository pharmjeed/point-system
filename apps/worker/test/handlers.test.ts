import { JOB_TYPES } from '@point/shared';
import { describe, expect, it } from 'vitest';
import { allHandlers } from '../src/handlers.js';

/** The worker registers each canon job (canon §7.2) at most once; the dispatcher refuses duplicates. */
describe('worker handlers', () => {
  it('one handler per job type, every type from the canon, job.export_generate included (PNT-089)', () => {
    const types = allHandlers().map((h) => h.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types.filter((x) => !(JOB_TYPES as readonly string[]).includes(x))).toEqual([]);
    expect(types).toContain('job.export_generate');
    expect(allHandlers().find((h) => h.type === 'job.export_generate')?.mode).toBe('external');
  });
});
