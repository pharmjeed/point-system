import { registerButtonPressHandler } from '../../modules/whatsapp/index.js';
import { handleButtonPress } from './button-press.js';
import { installCustomerLinking } from './linking.js';

/**
 * The S3 customer flows plugged into the S2 / adapter extension points (docs/progress/notes/s3-customer-flows.md):
 * the «طلب السيارة» press → RequestRetrieval (PNT-045) and the direct link at submit (PNT-043). Both need
 * no secret, so they are installed when the module is loaded (api and worker both import @point/server);
 * the claim code hook needs CODE_PEPPER and is registered by the api module (ClaimCodeHookRegistrar).
 * Idempotent: tests that reset the adapter's seams call it again.
 */
export function installCustomerFlows(): void {
  registerButtonPressHandler(handleButtonPress);
  installCustomerLinking();
}

installCustomerFlows();
