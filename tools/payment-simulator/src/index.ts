// @point/payment-simulator — fake Moyasar payments API + webhook emitter + test cards for dev/test (DEC-510).
export { PaymentSimulatorClient, PaymentSimulatorClientError } from './client.js';
export {
  assertNotProduction,
  assertTestKey,
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_PUBLISHABLE_KEY,
  DEFAULT_SECRET_KEY,
  DEFAULT_WEBHOOK_SECRET,
  optionsFromEnv,
  ProductionRefusedError,
  type PaymentSimulatorConfig,
  type PaymentSimulatorOptions,
} from './config.js';
export { TEST_CARDS, cardByNumber, maskedNumber, type CardBehaviour, type TestCard } from './cards.js';
export {
  createPaymentSimulatorServer,
  startPaymentSimulator,
  type PaymentSimulatorServer,
  type RunningPaymentSimulator,
} from './server.js';
export { PaymentSimulatorState, type SimPayment, type SimToken, type WebhookDelivery } from './state.js';
export { PAYMENT_EVENT_TYPES, eventFor, webhookBody, type PaymentEventType } from './webhook.js';
