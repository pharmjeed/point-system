/**
 * Where the session tokens live. On the device: expo-secure-store (Keychain / Android Keystore, ./secureStore.ts);
 * in tests: memory. Tokens are never written to logs, analytics or plain storage (CLAUDE.md §3 item 8).
 */

export interface StoredSession {
  accessToken: string;
  /** ISO-8601 UTC. */
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export interface TokenStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

/** A store in memory (tests and the fake backend's first run). */
export function memoryTokenStore(
  initial: StoredSession | null = null,
): TokenStore & { peek(): StoredSession | null } {
  let current = initial;
  return {
    load: async () => current,
    save: async (s) => {
      current = s;
    },
    clear: async () => {
      current = null;
    },
    peek: () => current,
  };
}

/** Parses what secure storage returned; anything malformed counts as no session. */
export function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof v.accessToken === 'string' &&
      typeof v.accessExpiresAt === 'string' &&
      typeof v.refreshToken === 'string' &&
      typeof v.refreshExpiresAt === 'string'
    ) {
      return {
        accessToken: v.accessToken,
        accessExpiresAt: v.accessExpiresAt,
        refreshToken: v.refreshToken,
        refreshExpiresAt: v.refreshExpiresAt,
      };
    }
  } catch {
    // fall through
  }
  return null;
}
