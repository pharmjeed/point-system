import { Platform, type TextStyle } from 'react-native';

/**
 * Text aligned to the «start» of the line. React Native on iOS/Android swaps `'left'` in RTL, so `'left'` stays the
 * native value. react-native-web keeps `'left'` physical, and resolves even `'start'` from its own locale context
 * (left-to-right unless a LocaleProvider says otherwise), so the web export (`export:web`: e2e V2-018 and store
 * screenshots V2-052; DEC-551, DEC-568) sets nothing: the browser's default `start` then follows each text's own
 * `dir="auto"` under `<html dir="rtl">` — Arabic on the right, a plate or a phone number on the left.
 */
export const textStart: TextStyle['textAlign'] = Platform.OS === 'web' ? undefined : 'left';
