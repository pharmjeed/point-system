import { Platform, type TextStyle } from 'react-native';

/**
 * Text aligned to the «start» of the line. React Native on iOS/Android swaps `'left'` in RTL, so `'left'` stays the
 * native value; react-native-web keeps `'left'` physical and flips only `'start'` (outside the RN types), which the
 * e2e web export (V2-018, DEC-551) needs for Arabic to sit on the right.
 */
export const textStart = (Platform.OS === 'web' ? 'start' : 'left') as TextStyle['textAlign'];
