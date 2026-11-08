/**
 * Builds the client for the configured mode: the real API over HTTPS (V2-010), or the in-memory fake (development,
 * DEC-482). The fake lives for the app's lifetime (accounts and codes are lost when the app restarts).
 */
import { Platform } from 'react-native';
import { io } from 'socket.io-client';
import { fakeVisitEvents, socketVisitEvents, type VisitEvents } from '../realtime/visitEvents';
import type { AppConfig } from '../configModel';
import { newIdempotencyKey, secureTokenStore } from '../session/secureStore';
import { createCustomerApi, type CustomerApi } from './client';
import { createFakeBackend, type FakeBackend } from './fake/backend';
import { httpTransport } from './transport';

export interface ApiBundle {
  api: CustomerApi;
  /** Present in fake mode only (the C-03 development banner reads the simulated WhatsApp inbox). */
  fake: FakeBackend | null;
  /** V2-015 (DEC-520): `visit.updated` of the customer socket (or the fake's events) */
  events: VisitEvents;
}

/** Phones that get a sample visit in progress in fake mode (README). */
const DEMO_VISIT_PHONES = ['+966500000099'];

export function createApi(config: AppConfig, deviceId: string, onSignedOut: () => void): ApiBundle {
  const fake =
    config.api.mode === 'fake'
      ? createFakeBackend({ latencyMs: 300, demoVisitPhones: DEMO_VISIT_PHONES, brand: config.brand })
      : null;
  const transport = fake ? fake.transport : httpTransport({ baseUrl: config.api.baseUrl as string });
  const api = createCustomerApi({
    transport,
    tokens: secureTokenStore,
    device: { id: deviceId, platform: Platform.OS === 'ios' ? 'ios' : 'android' },
    newKey: newIdempotencyKey,
    onSignedOut,
  });
  const events = fake
    ? fakeVisitEvents({
        subscribe: fake.visits.subscribeByToken,
        tick: fake.visits.tick,
        accessToken: () => api.accessToken(),
      })
    : socketVisitEvents({ baseUrl: config.api.baseUrl as string, accessToken: () => api.accessToken(), io });
  return { api, fake, events };
}
