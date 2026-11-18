import Constants from 'expo-constants';
import { parseAppConfig, type AppConfig } from './configModel';

/** The app's configuration from app.config.ts `extra` (brand, API mode, maps, support) and its version. */
export const appConfig: AppConfig = parseAppConfig(
  Constants.expoConfig?.extra,
  __DEV__,
  Constants.expoConfig?.version,
);
