/**
 * Brand names (canon §1). They are read from the `BRAND_*` environment variables and never written
 * in code elsewhere; this file holds the documented defaults (file 05 `.env.example`). The web app
 * reads the staff names from `VITE_BRAND_STAFF_NAME_*`.
 *
 * This file and wa-templates.ts are the only shared files allowed to contain the brand names
 * (scripts/check-brand.mjs).
 */
import { z } from 'zod';

export const BRAND_ENV_VARS = [
  'BRAND_STAFF_NAME_AR',
  'BRAND_STAFF_NAME_EN',
  'BRAND_CUSTOMER_NAME_AR',
  'BRAND_CUSTOMER_NAME_EN',
] as const;
export type BrandEnvVar = (typeof BRAND_ENV_VARS)[number];

/** Defaults of canon §1 / file 05. */
export const BRAND_DEFAULTS: Readonly<Record<BrandEnvVar, string>> = {
  BRAND_STAFF_NAME_AR: 'بوينت',
  BRAND_STAFF_NAME_EN: 'POINT',
  BRAND_CUSTOMER_NAME_AR: 'مصاف',
  BRAND_CUSTOMER_NAME_EN: 'MASAF',
};

/** Web-app (Vite) variables: staff names only (file 05). */
export const VITE_BRAND_ENV_VARS = ['VITE_BRAND_STAFF_NAME_AR', 'VITE_BRAND_STAFF_NAME_EN'] as const;
export type ViteBrandEnvVar = (typeof VITE_BRAND_ENV_VARS)[number];

export interface BrandNames {
  /** Staff system name (Arabic). */
  staffNameAr: string;
  /** Staff system name (Latin). */
  staffNameEn: string;
  /** Customer channel name (Arabic) — customer-facing text only. */
  customerNameAr: string;
  /** Customer channel name (Latin). */
  customerNameEn: string;
}

const nonEmpty = z.string().trim().min(1);

export const brandEnvSchema = z.object({
  BRAND_STAFF_NAME_AR: nonEmpty.default(BRAND_DEFAULTS.BRAND_STAFF_NAME_AR),
  BRAND_STAFF_NAME_EN: nonEmpty.default(BRAND_DEFAULTS.BRAND_STAFF_NAME_EN),
  BRAND_CUSTOMER_NAME_AR: nonEmpty.default(BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_AR),
  BRAND_CUSTOMER_NAME_EN: nonEmpty.default(BRAND_DEFAULTS.BRAND_CUSTOMER_NAME_EN),
});

/**
 * Resolves the brand names from an environment (e.g. `process.env`). Missing or blank variables
 * fall back to {@link BRAND_DEFAULTS}. `prefix` reads e.g. `VITE_BRAND_STAFF_NAME_AR` with `'VITE_'`.
 */
export function resolveBrand(env: Readonly<Record<string, string | undefined>>, prefix = ''): BrandNames {
  const pick = (name: BrandEnvVar): string | undefined => {
    const value = env[`${prefix}${name}`]?.trim();
    return value ? value : undefined;
  };
  const parsed = brandEnvSchema.parse({
    BRAND_STAFF_NAME_AR: pick('BRAND_STAFF_NAME_AR'),
    BRAND_STAFF_NAME_EN: pick('BRAND_STAFF_NAME_EN'),
    BRAND_CUSTOMER_NAME_AR: pick('BRAND_CUSTOMER_NAME_AR'),
    BRAND_CUSTOMER_NAME_EN: pick('BRAND_CUSTOMER_NAME_EN'),
  });
  return {
    staffNameAr: parsed.BRAND_STAFF_NAME_AR,
    staffNameEn: parsed.BRAND_STAFF_NAME_EN,
    customerNameAr: parsed.BRAND_CUSTOMER_NAME_AR,
    customerNameEn: parsed.BRAND_CUSTOMER_NAME_EN,
  };
}
