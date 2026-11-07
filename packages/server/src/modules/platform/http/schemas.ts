import { z } from 'zod';

export const PlatformLoginBody = z.strictObject({
  phone: z.string().min(1).max(32),
  secret: z.string().min(6).max(128),
});
export const PlatformMfaVerifyBody = z.strictObject({
  mfa_token: z.string().min(16).max(256),
  code: z.string().regex(/^[0-9]{6}$/),
});
export const PlatformMfaConfirmBody = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) });
export const PlatformSecretChangeBody = z.strictObject({
  current_secret: z.string().min(1).max(128),
  new_secret: z.string().min(6).max(128),
});

export type PlatformLoginBody = z.infer<typeof PlatformLoginBody>;
export type PlatformMfaVerifyBody = z.infer<typeof PlatformMfaVerifyBody>;
export type PlatformMfaConfirmBody = z.infer<typeof PlatformMfaConfirmBody>;
export type PlatformSecretChangeBody = z.infer<typeof PlatformSecretChangeBody>;
