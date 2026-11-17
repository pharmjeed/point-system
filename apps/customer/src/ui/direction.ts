import { I18nManager, type ViewStyle } from 'react-native';

/**
 * The layout direction of the app: React Native mirrors `row` in RTL on iOS and Android. Directional icons (back,
 * the «go» chevrons) are flipped with it (03 §2.6, DEC-85); the others never are.
 */
export const isRTL = (): boolean => I18nManager.isRTL;

/**
 * An absolute offset from the start edge of the line (V2-UX option B, DEC-580: the hero's circle and the car on its
 * road). iOS and Android resolve `start` from the layout direction themselves.
 */
export const fromStart = (value: number): ViewStyle => ({ start: value });
