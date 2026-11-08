import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  ApiExceptionFilter,
  dbUnavailableError,
  isDbUnavailableError,
  mapPgError,
  markDbError,
  toAppError,
  toHttpAppError,
  type Logger,
} from '../src/index.js';

const errno = (code: string, message = `connect ${code} 127.0.0.1:5432`) =>
  Object.assign(new Error(message), { code, errno: -111, syscall: 'connect' });
/** The same errno raised by the database layer (Database / Tx mark what the pool and the client throw). */
const dbErrno = (code: string, message?: string) => markDbError(errno(code, message));
const pgError = (code: string, message: string) =>
  Object.assign(new Error(message), { code, severity: 'FATAL' });
/** What raw-body 3 raises when the client goes away mid-body (`createError(400, 'request aborted', …)`). */
const abortedBody = () =>
  Object.assign(new Error('request aborted'), {
    code: 'ECONNABORTED',
    expected: 2048,
    length: 2048,
    received: 512,
    type: 'request.aborted',
    status: 400,
    statusCode: 400,
    expose: true,
  });
/** body-parser wraps a stream error of the request in createError(400, err): a socket errno with a status. */
const resetBody = () =>
  Object.assign(errno('ECONNRESET', 'aborted'), { status: 400, statusCode: 400, expose: true });

/** 17 §12 / 08 §5: an unreachable database answers SERVICE_UNAVAILABLE (retryable), never INTERNAL_ERROR. */
describe('database unavailable → SERVICE_UNAVAILABLE', () => {
  it('recognises socket errors of the database layer, lost connections, pool and read timeouts, «not accepting connections»', () => {
    for (const e of [
      dbErrno('ECONNREFUSED'),
      dbErrno('ECONNRESET', 'read ECONNRESET'),
      dbErrno('EPIPE', 'write EPIPE'),
      dbErrno('ETIMEDOUT'),
      new Error('Connection terminated unexpectedly'),
      new Error('Connection terminated'),
      new Error('Connection terminated due to connection timeout'),
      new Error('Client has encountered a connection error and is not queryable'),
      new Error('timeout exceeded when trying to connect'),
      // DEC-PROPOSED-8: the client read timeout of a server that stopped answering (pg `query_timeout`)
      new Error('Query read timeout'),
      markDbError(new Error('timeout expired')),
      pgError('55000', 'database "point_x" is not currently accepting connections'),
      pgError('57P01', 'terminating connection due to administrator command'),
      pgError('08006', 'connection failure'),
      pgError('53300', 'sorry, too many clients already'),
      markDbError(new AggregateError([errno('ECONNREFUSED'), errno('ECONNREFUSED')], 'connect failed')),
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
      markDbError(new AggregateError([errno('ECONNREFUSED'), new Error('boom')], 'mixed')),
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
    expect(toAppError(dbErrno('EPIPE', 'write EPIPE'), {})?.code).toBe('SERVICE_UNAVAILABLE');
    expect(dbUnavailableError(dbErrno('EPIPE'))?.options.retryAfterS).toBe(2);
  });

  it('a socket errno outside the database layer is not the database (HTTP body, another dependency)', () => {
    // review finding: raw-body's «request aborted» is ECONNABORTED — a client that went away, not a 503
    for (const e of [abortedBody(), resetBody(), errno('ECONNRESET'), errno('ETIMEDOUT'), errno('ENOTFOUND')])
      expect(isDbUnavailableError(e), e.message).toBe(false);
    // an HTTP error object is never a database error, even when marked
    expect(isDbUnavailableError(markDbError(abortedBody()))).toBe(false);
    const aborted = toHttpAppError(abortedBody());
    expect(aborted.error.code).toBe('VALIDATION_FAILED'); // what it answered before the review finding
    expect(aborted.error.http).toBe(422);
    expect(aborted.unexpected).toBe(false);
    expect(toHttpAppError(resetBody()).error.code).toBe('VALIDATION_FAILED');
    expect(toHttpAppError(dbErrno('ECONNRESET')).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(toHttpAppError(new Error('Query read timeout')).error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('the exception filter answers an aborted body VALIDATION_FAILED (422) and logs it at info, a lost database 503 at error', () => {
    const run = (err: unknown) => {
      const logged: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
      const at =
        (level: string) =>
        (fields: Record<string, unknown>, msg: string): void => {
          logged.push({ level, msg, fields });
        };
      const logger = { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
      const res = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: '',
        setHeader(k: string, v: string) {
          this.headers[k.toLowerCase()] = v;
        },
        status(s: number) {
          this.statusCode = s;
          return this;
        },
        type() {
          return this;
        },
        send(b: string) {
          this.body = b;
          return this;
        },
      };
      const req = { headers: {}, path: '/v1/tickets', requestId: 'req-1' };
      const host = {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      } as unknown as ArgumentsHost;
      new ApiExceptionFilter(logger as unknown as Logger).catch(err, host);
      return { res, logged };
    };

    const aborted = run(abortedBody());
    expect(aborted.res.statusCode).toBe(422);
    expect(JSON.parse(aborted.res.body).error.code).toBe('VALIDATION_FAILED');
    expect(aborted.logged.map((l) => [l.level, l.msg])).toEqual([['info', 'request rejected']]);

    const lost = run(dbErrno('ECONNRESET', 'read ECONNRESET'));
    expect(lost.res.statusCode).toBe(503);
    expect(lost.res.headers['retry-after']).toBe('2');
    expect(lost.logged.map((l) => l.level)).toEqual(['error']);
  });
});
