/**
 * The 02 §8.4 intake pick lists. The make and the colour travel and are stored as these keys (02 §9.3 item 16,
 * DEC-350); «أخرى» sends the typed text instead. The staff UI translates them itself (apps/web/src/i18n/ar.ts);
 * the server translates them wherever it writes Arabic for people: the customer's W-01 `{{3}}` (12 §5, 14 §4)
 * and the CSV exports. Free text passes through unchanged.
 */
export const VEHICLE_COLOR_LABELS_AR = {
  white: 'أبيض',
  black: 'أسود',
  silver: 'فضي',
  gray: 'رمادي',
  red: 'أحمر',
  blue: 'أزرق',
  navy: 'كحلي',
  green: 'أخضر',
  beige: 'بيج',
  brown: 'بني',
  gold: 'ذهبي',
  yellow: 'أصفر',
  orange: 'برتقالي',
  other: 'أخرى',
} as const;

export const VEHICLE_MAKE_LABELS_AR = {
  toyota: 'تويوتا',
  hyundai: 'هيونداي',
  nissan: 'نيسان',
  kia: 'كيا',
  lexus: 'لكزس',
  ford: 'فورد',
  chevrolet: 'شيفروليه',
  gmc: 'جي إم سي',
  mercedes: 'مرسيدس',
  bmw: 'بي إم دبليو',
  honda: 'هوندا',
  mazda: 'مازدا',
  mitsubishi: 'ميتسوبيشي',
  land_rover: 'لاند روفر',
  audi: 'أودي',
  geely: 'جيلي',
  changan: 'شانجان',
  mg: 'إم جي',
  other: 'أخرى',
} as const;

export type VehicleColorKey = keyof typeof VEHICLE_COLOR_LABELS_AR;
export type VehicleMakeKey = keyof typeof VEHICLE_MAKE_LABELS_AR;

function label(map: Readonly<Record<string, string>>, value: string | null | undefined): string | null {
  if (value == null) return null;
  return Object.hasOwn(map, value) ? (map[value] ?? value) : value;
}

/** `toyota` → «تويوتا»; a typed make («بروتون») or an unknown value is returned as is; null stays null. */
export const vehicleMakeLabelAr = (value: string | null | undefined): string | null =>
  label(VEHICLE_MAKE_LABELS_AR, value);

/** `white` → «أبيض»; a typed colour or an unknown value is returned as is; null stays null. */
export const vehicleColorLabelAr = (value: string | null | undefined): string | null =>
  label(VEHICLE_COLOR_LABELS_AR, value);
