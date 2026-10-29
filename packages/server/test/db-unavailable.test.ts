import { describe, expect, it } from 'vitest';
import { dbUnavailableError, isDbUnavailableError, mapPgError, toAppError } from '../src/index.js';

const errno = (code: string, message = `connect ${code} 127.0.0.1:5432`) =>
  Object.assign(new Error(message), { code, errno: -111, syscall: 'connect' });
const pgError = (code: string, message: string) =>
  Object.assign(new Error(message), { code, severity: 'FATAL' });

/** 17 §12 / 08 §5: an unreachable database answers SERVICE_UNAVAILABLE (retryable), never INTERNAL_ERROR. */
describe('database unavailable → SERVICE_UNAVAILABLE', () => {
  it('recognises socket errors, lost connections, pool timeouts and «not accepting connections»', () => {
    for (const e of [
      errno('ECONNREFUSED'),
      errno('ECONNRESET', 'read ECONNRESET'),
      errno('EPIPE', 'write EPIPE'),
      errno('ETIMEDOUT'),
      new Error('Connection terminated unexpectedly'),
      new Error('Connection terminated'),
      new Error('Client has encountered a connection error and is not queryable'),
      new Error('timeout exceeded when trying to connect'),
      pgError('55000', 'database "point_x" is not currently accepting connections'),
      pgError('57P01', 'terminating connection due to administrator command'),
      pgError('08006', 'connection failure'),
      pgError('53300', 'sorry, too many clients already'),
      new AggregateError([errno('ECONNREFUSED'), errno('ECONNREFUSED')], 'connect failed'),
    ]) {
      expect(isDbUnavailableError(e), String(e.message)).toBe(true);
      expect(dbUnavailableError(e)?.code).toBe('SERVICE_UNAVAILABLE');
      expect(toAppError(e, {})?.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('leaves real faults alone', () => {
    for (const e of [
      new Error('boom'),
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      pgError('23505', 'duplicate key value violates unique constraint "uq_x"'),
      pgError('57014', 'canceling statement due to statement timeout'),
      pgError('55000', 'some other prerequisite state'),
      new AggregateError([errno('ECONNREFUSED'), new Error('boom')], 'mixed'),
      null,
      'ECONNREFUSED',
    ]) {
      expect(isDbUnavailableError(e)).toBe(false);
    }
    // a 55000 that is not about connections stays an internal error
    expect(mapPgError({ code: '55000' }).error.code).toBe('INTERNAL_ERROR');
    expect(
      mapPgError(pgError('55000', 'database "point_x" is not currently accepting connections')).error.code,
    ).toBe('SERVICE_UNAVAILABLE');
    // EPIPE has the shape of a SQLSTATE but is a socket error
    expect(toAppError(errno('EPIPE', 'write EPIPE'), {})?.code).toBe('SERVICE_UNAVAILABLE');
    expect(dbUnavailableError(errno('EPIPE'))?.options.retryAfterS).toBe(2);
  });
});
