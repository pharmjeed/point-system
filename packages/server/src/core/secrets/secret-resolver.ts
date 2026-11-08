/**
 * Secret references (05 §7.7): `env://NAME` reads an environment variable (local/staging); `sm://path`
 * reads the secret manager configured for the environment. whatsapp_channel.*_secret_ref store references,
 * never values.
 */
export interface SecretManager {
  get(path: string): Promise<string | null>;
}

export class SecretResolver {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly manager: SecretManager | null = null,
  ) {}

  async resolve(ref: string | null | undefined): Promise<string | null> {
    if (!ref) return null;
    if (ref.startsWith('env://')) return this.env[ref.slice('env://'.length)] || null;
    if (ref.startsWith('sm://')) {
      if (!this.manager) throw new Error(`secret manager not configured for ${ref.split('/')[0]}//…`);
      return this.manager.get(ref.slice('sm://'.length));
    }
    throw new Error('unsupported secret reference scheme');
  }

  async require(ref: string): Promise<string> {
    const v = await this.resolve(ref);
    if (!v) throw new Error(`secret ${ref.replace(/^(env|sm):\/\//, '$1://')} is not set`);
    return v;
  }
}
