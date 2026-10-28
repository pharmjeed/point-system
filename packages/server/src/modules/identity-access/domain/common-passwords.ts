/**
 * Local list of common passwords refused for staff accounts (09 §9.1: "تُرفض الشائعة من قائمة محلية").
 * Compared case-insensitively after trimming. Kept short and deliberate; extend at hardening (PNT-096).
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '111111111111',
  '000000000000',
  '123123123123',
  'password1234',
  'password12345',
  'passwordpassword',
  'qwertyuiop12',
  'qwertyuiopasdf',
  '1q2w3e4r5t6y',
  'iloveyou1234',
  'welcome12345',
  'admin1234567',
  'administrator',
  'letmein12345',
  'abcdefghijkl',
  'abc123abc123',
  'changeme1234',
  'point1234567',
  'masaf1234567',
  'valet1234567',
  'riyadh123456',
  'saudi1234567',
  'ksa123456789',
  'mohammed1234',
  'abdullah1234',
]);
