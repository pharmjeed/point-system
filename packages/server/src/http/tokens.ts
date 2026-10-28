/** DI tokens for the core services (apps/api and apps/worker provide them). */
export const ENV = Symbol('ENV');
export const DATABASE = Symbol('DATABASE');
export const LOGGER = Symbol('LOGGER');
export const SECRETS = Symbol('SECRETS');
export { CLOCK } from '../core/clock/clock.js';
