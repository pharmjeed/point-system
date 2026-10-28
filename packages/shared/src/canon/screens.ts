/**
 * Screen ids (canon §14). Specs in file 02. Customer messages W-01 … W-12 are in wa-templates.ts.
 */
import { z } from 'zod';
import type { WaMessageId } from './wa-templates.js';
import { WA_MESSAGE_IDS } from './wa-templates.js';

/** Driver screens. */
export const DRIVER_SCREEN_IDS = [
  'D-01',
  'D-02',
  'D-03',
  'D-04',
  'D-05',
  'D-06',
  'D-07',
  'D-08',
  'D-09',
  'D-10',
  'D-11',
  'D-12',
  'D-13',
  'D-14',
  'D-15',
] as const;
export type DriverScreenId = (typeof DRIVER_SCREEN_IDS)[number];

/** Supervisor and admin screens. */
export const SUPERVISOR_SCREEN_IDS = [
  'S-01',
  'S-02',
  'S-03',
  'S-04',
  'S-05',
  'S-06',
  'S-07',
  'S-08',
  'S-09',
  'S-10',
  'S-11',
  'S-12',
  'S-13',
] as const;
export type SupervisorScreenId = (typeof SUPERVISOR_SCREEN_IDS)[number];

/** Staff web-app screens (driver + supervisor/admin). */
export const STAFF_SCREEN_IDS = [...DRIVER_SCREEN_IDS, ...SUPERVISOR_SCREEN_IDS] as const;
export type StaffScreenId = (typeof STAFF_SCREEN_IDS)[number];
export const StaffScreenIdSchema = z.enum(STAFF_SCREEN_IDS);

/** Every screen id of canon §14, including the customer WhatsApp messages. */
export const SCREEN_IDS = [...STAFF_SCREEN_IDS, ...WA_MESSAGE_IDS] as const;
export type ScreenId = StaffScreenId | WaMessageId;
export const ScreenIdSchema = z.enum(SCREEN_IDS);

/** Short Arabic titles of the staff screens (canon §14). */
export const SCREEN_TITLES_AR: Readonly<Record<StaffScreenId, string>> = {
  'D-01': 'الدخول',
  'D-02': 'تغيير الرقم السري',
  'D-03': 'بدء الوردية واختبار الصوت',
  'D-04': 'الرئيسية',
  'D-05': 'استلام مركبة (1): المركبة والعميل',
  'D-06': 'استلام مركبة (2): المفتاح والصور',
  'D-07': 'ربط واتساب (لوحة QR موجهة للعميل)',
  'D-08': 'إتمام الصف',
  'D-09': 'بطاقة العرض/البث',
  'D-10': 'المهمة الحالية (الإحضار)',
  'D-11': 'التسليم والتحصيل',
  'D-12': 'المركبات',
  'D-13': 'تفاصيل المركبة',
  'D-14': 'حسابي',
  'D-15': 'حالات النظام (انقطاع، جلسة منتهية، صوت محجوب، تحديث)',
  'S-01': 'الدخول وMFA',
  'S-02': 'لوحة التشغيل',
  'S-03': 'تفاصيل التذكرة وسجلها',
  'S-04': 'مركز التنبيهات',
  'S-05': 'السائقون',
  'S-06': 'ملف السائق',
  'S-07': 'نقل سائق',
  'S-08': 'المواقع والحفلات',
  'S-09': 'إعداد الموقع',
  'S-10': 'إغلاق الحفل والمطابقة',
  'S-11': 'التقارير والتصدير',
  'S-12': 'الوقائع',
  'S-13': 'الإدارة (الموظفون، قناة واتساب، القوالب، التدقيق، الاحتفاظ)',
};
