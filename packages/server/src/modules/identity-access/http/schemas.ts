import { z } from 'zod';

const uuid = z.uuid();
const reason = z.string().trim().min(3, 'REASON_REQUIRED').max(500);

export const LoginBody = z.strictObject({
  phone: z.string().min(1).max(32),
  secret: z.string().min(6).max(128),
  device_label: z.string().max(60).optional(),
});
export const MfaVerifyBody = z.strictObject({
  mfa_token: z.string().min(16).max(256),
  code: z.string().regex(/^[0-9]{6}$/),
});
export const MfaConfirmBody = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) });
export const SecretChangeBody = z.strictObject({
  current_secret: z.string().min(1).max(128),
  new_secret: z.string().min(6).max(128),
});

export const DeviceRegisterBody = z.strictObject({
  label: z.string().max(60).optional(),
  platform: z.enum(['ios', 'android', 'desktop', 'other']),
  display_mode: z.enum(['browser', 'standalone']),
  notification_permission: z.enum(['default', 'granted', 'denied', 'unsupported']),
});
export const DeviceUpdateBody = z.strictObject({
  label: z.string().max(60).nullable().optional(),
  display_mode: z.enum(['browser', 'standalone']).optional(),
  notification_permission: z.enum(['default', 'granted', 'denied', 'unsupported']).optional(),
  push_subscription: z
    .strictObject({
      endpoint: z.url(),
      keys: z.strictObject({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(256) }),
    })
    .nullable()
    .optional(),
});
export const AudioTestBody = z.strictObject({
  device_id: uuid,
  result: z.enum(['heard', 'not_heard', 'blocked']),
});
export const HeartbeatBody = z.strictObject({
  visible: z.boolean(),
  audio_unlocked: z.boolean(),
  ws_connected: z.boolean(),
  last_event_id: z.string().max(64).nullable().optional(),
  app_version: z.string().max(32).optional(),
});

const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
};
export const DriversQuery = z.strictObject({
  venue_id: uuid.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  driver_state: z
    .enum(['off_duty', 'on_break', 'available', 'intake_parking', 'retrieving', 'busy_with_next'])
    .optional(),
  q: z.string().max(60).optional(),
  ...page,
});
export const DriverCreateBody = z.strictObject({
  full_name: z.string().trim().min(1).max(80),
  phone: z.string().min(1).max(32),
  employee_code: z.string().trim().min(1).max(20).optional(),
  initial_venue_id: uuid.nullable().optional(),
});
export const DriverPatchBody = z.strictObject({
  expected_version: z.number().int().min(1),
  full_name: z.string().trim().min(1).max(80).optional(),
  phone: z.string().min(1).max(32).optional(),
  employee_code: z.string().trim().min(1).max(20).optional(),
});
export const ReasonBody = z.strictObject({ reason });
export const AssignmentBody = z.strictObject({
  venue_id: uuid,
  reason: z.string().max(300).nullable().optional(),
});

export const StaffQuery = z.strictObject({
  role: z.enum(['admin', 'supervisor']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  ...page,
});
export const StaffCreateBody = z.strictObject({
  full_name: z.string().trim().min(1).max(80),
  phone: z.string().min(1).max(32),
  role: z.enum(['admin', 'supervisor']),
  can_drive: z.boolean().default(false),
  venue_ids: z.array(uuid).max(50).optional(),
});
export const StaffPatchBody = z.strictObject({
  expected_version: z.number().int().min(1),
  full_name: z.string().trim().min(1).max(80).optional(),
  phone: z.string().min(1).max(32).optional(),
  can_drive: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  reason: z.string().max(500).optional(),
});
export const ScopesBody = z.strictObject({
  grant_venue_ids: z.array(uuid).max(50).optional(),
  revoke_venue_ids: z.array(uuid).max(50).optional(),
  org_scope: z.boolean().optional(),
});
