import argon2 from 'argon2';

/**
 * argon2id with the OWASP parameters of 09 §9.1 (19 MiB, 2 iterations, parallelism 1) and the
 * AUTH_SECRET_PEPPER passed as argon2's `secret` (DEC-58) — the same scheme as the seed.
 */
export class SecretHasher {
  private readonly opts: {
    type: typeof argon2.argon2id;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
    secret: Buffer;
  };
  private dummy: Promise<string> | null = null;

  constructor(pepper: string) {
    this.opts = {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      secret: Buffer.from(pepper, 'utf8'),
    };
  }

  hash(secret: string): Promise<string> {
    return argon2.hash(secret, { ...this.opts, raw: false });
  }

  async verify(hash: string, secret: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, secret, { secret: this.opts.secret });
    } catch {
      return false;
    }
  }

  /** Burn the same time for an unknown phone as for a wrong secret (no account enumeration by timing). */
  async verifyDummy(secret: string): Promise<false> {
    this.dummy ??= this.hash('dummy-secret-for-timing');
    await this.verify(await this.dummy, secret);
    return false;
  }
}
