/// <reference types="vite/client" />

// Public build-time variables only (05 §7.7, §8): never a secret here.
interface ImportMetaEnv {
  /** Empty = same origin (DEC-29). */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WS_PATH?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  /** Staff brand (canon §1). Defaults to the manifest short_name at build time when unset (vite.config.ts). */
  readonly VITE_BRAND_STAFF_NAME_AR?: string;
  readonly VITE_BRAND_STAFF_NAME_EN?: string;
  /** Customer brand: only for the allowed surfaces (D-07 QR panel, S-03 preview, S-13 channel settings). */
  readonly VITE_BRAND_CUSTOMER_NAME_AR?: string;
  readonly VITE_APP_VERSION?: string;
  /** "true" adds the component gallery route (/_gallery) to the build; never set in production. */
  readonly VITE_ENABLE_GALLERY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
