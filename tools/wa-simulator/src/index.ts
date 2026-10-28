// @point/wa-simulator — fake WhatsApp Cloud (Graph) API + signed webhook emitter for dev/test (docs/12 §11).
export {
  SimulatorClient,
  SimulatorClientError,
  type SimulatorClientOptions,
  type WaitOptions,
} from './client.js';
export {
  assertNotProduction,
  ConfigError,
  DEFAULT_DISPLAY_PHONE_E164,
  DEFAULT_PHONE_NUMBER_ID,
  DEFAULT_PORT,
  DEFAULT_WABA_ID,
  optionsFromEnv,
  ProductionRefusedError,
  type SimulatorConfig,
  type SimulatorOptions,
} from './config.js';
export {
  graphErrorBody,
  graphErrorInfo,
  knownGraphErrors,
  PERMANENT_CODES,
  RETRYABLE_CODES,
  type GraphErrorClass,
  type GraphErrorInfo,
} from './graph-errors.js';
export { bsuidFor } from './ids.js';
export { BUILTIN_SCENARIOS } from './scenarios.js';
export {
  createSimulatorServer,
  startSimulator,
  type RunningSimulator,
  type SimulatorServer,
} from './server.js';
export { SIGNATURE_HEADER, signWebhookBody, verifyWebhookSignature } from './signature.js';
export type * from './types.js';
