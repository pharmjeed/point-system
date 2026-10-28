/**
 * Brand names (canon §1): read from the build environment only — `VITE_BRAND_*` (05 §8). No literal brand
 * name exists in the source (scripts/check-brand.mjs). At runtime `GET /v1/me` may also return `brand`
 * (org settings); `resolveBrand()` prefers those values when present.
 *
 * The staff UI shows the staff name; the customer name is only for the surfaces canon §1 allows
 * (D-07 QR panel, S-03 message preview, S-13 channel settings).
 */
export interface BrandNames {
  staffNameAr: string;
  staffNameEn: string;
  customerNameAr: string;
}

const env = import.meta.env;

export const envBrand: BrandNames = {
  staffNameAr: env.VITE_BRAND_STAFF_NAME_AR || env.VITE_BRAND_STAFF_NAME_EN || '',
  staffNameEn: env.VITE_BRAND_STAFF_NAME_EN || '',
  customerNameAr: env.VITE_BRAND_CUSTOMER_NAME_AR || '',
};

export interface ServerBrand {
  staff_name_ar?: string;
  staff_name_en?: string;
  customer_name_ar?: string;
}

export function resolveBrand(server?: ServerBrand | null): BrandNames {
  return {
    staffNameAr: server?.staff_name_ar || envBrand.staffNameAr,
    staffNameEn: server?.staff_name_en || envBrand.staffNameEn,
    customerNameAr: server?.customer_name_ar || envBrand.customerNameAr,
  };
}
