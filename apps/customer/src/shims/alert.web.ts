/**
 * The one web export only (`export:web`: e2e V2-018 and store screenshots V2-052; DEC-551, DEC-568): react-native-web's `Alert.alert` does nothing, so every confirmation of
 * the app (C-12 «اطلب السيارة», C-14 «إيقاف التجديد», C-15 / C-18 «حذف») would never reach its action. Here the
 * same title, message and buttons go through the browser's own dialog: one button → `alert`, more → `confirm`
 * (OK = the last button that is not `cancel`, Cancel = the `cancel` button). Playwright answers it like a person
 * taps the native dialog. iOS and Android keep the native Alert (./alert.ts is empty).
 */
import { Alert, type AlertButton } from 'react-native';

Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
  const text = message ? `${title}\n${message}` : title;
  const list = buttons ?? [];
  if (list.length <= 1) {
    window.alert(text);
    list[0]?.onPress?.();
    return;
  }
  const cancel = list.find((b) => b.style === 'cancel');
  const action = [...list].reverse().find((b) => b.style !== 'cancel');
  if (window.confirm(text)) action?.onPress?.();
  else cancel?.onPress?.();
};
