export { PlatformHttpModule } from './platform.module.js';
export { PlatformAuthService } from './application/platform-auth-service.js';
export {
  issuePlatformSession,
  issuePlatformMfaChallenge,
  revokePlatformSessions,
  setPlatformSessionCookie,
  clearPlatformSessionCookie,
  type IssuedPlatformSession,
} from './application/platform-sessions.js';
export { buildPlatformMe, platformUserView, type PlatformUserRow } from './application/platform-views.js';
export { assertNoContractOverlap, type IsoDate } from './application/operator-contracts.js';
export { OperatorsService, OPERATOR_STATUS_ACTIONS } from './application/operators-service.js';
// the public listings (V2-004) read the operator's status through the core helper (DEC-487)
export { isOperatorActive, assertOperatorOperating } from '../../core/operator-status.js';
