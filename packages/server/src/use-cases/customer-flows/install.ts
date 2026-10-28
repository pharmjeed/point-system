import { installCustomerLinking } from './linking.js';

/**
 * The S3 customer flows plugged into the S2 / adapter extension points: the direct link at submit (PNT-043).
 * It needs no secret, so it is installed when the module is loaded (api and worker both import @point/server).
 * Idempotent: tests that reset the adapter's seams call it again.
 */
export function installCustomerFlows(): void {
  installCustomerLinking();
}

installCustomerFlows();
