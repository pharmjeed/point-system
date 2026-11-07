import Constants from 'expo-constants';
import { parseAppConfig, type AppConfig } from './configModel';

/** The app's configuration from app.config.ts `extra` (brand names, API mode), validated once at start-up. */
export const appConfig: AppConfig = parseAppConfig(Constants.expoConfig?.extra, __DEV__);
