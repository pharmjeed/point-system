/**
 * `Idempotency-Key` per command (03 §3.1): one key from the first press, reused when the customer retries the
 * same input after a network error, a new one as soon as the input changes or after success.
 */
export class CommandKey {
  private key: string | null = null;
  private signature: string | null = null;

  constructor(private readonly generate: () => string) {}

  /** The key for this input (`signature` = anything that identifies the input, e.g. the JSON body). */
  for(signature: string): string {
    if (this.key === null || this.signature !== signature) {
      this.key = this.generate();
      this.signature = signature;
    }
    return this.key;
  }

  /** After the server accepted the command. */
  reset(): void {
    this.key = null;
    this.signature = null;
  }
}
