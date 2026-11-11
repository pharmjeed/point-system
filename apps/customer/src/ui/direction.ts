import { I18nManager } from 'react-native';

/**
 * The layout direction of the app: React Native mirrors `row` in RTL on iOS and Android. Directional icons (back,
 * the «go» chevrons) are flipped with it (03 §2.6, DEC-85); the others never are.
 */
export const isRTL = (): boolean => I18nManager.isRTL;
