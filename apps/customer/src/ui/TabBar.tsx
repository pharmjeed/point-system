/**
 * The bottom tab bar of the signed-in area (V2-UX option B «البطاقة الحية», DEC-582): الرئيسية `C-06` · زياراتي
 * `C-16` · اشتراكاتي `C-14` · حسابي `C-19`, each a Lucide icon over its name, the current one in the brand blue and
 * semibold (colour is never the only sign: the text weight changes and screen readers hear «محدد»). It replaces the
 * quick actions of C-06 and the settings button of its top bar; their test ids stay on the tabs that took their place
 * (`home-visits`, `home-settings`). A white bar with a hairline above it, at least `bottomnav-h` (64) tall plus the
 * device's bottom safe area. Full-screen flows (C-12, C-11, the pay and subscribe sheets, sign-in) are stack screens
 * above the tabs, so the bar is not drawn there.
 */
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../i18n/I18nProvider';
import { color, font, fontSize, layout, space } from '../theme/tokens';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { Touchable } from './Touchable';

/** The routes of `src/app/(tabs)/`, in the order of the bar. */
export const TAB_ROUTES = ['home', 'visits', 'subscriptions', 'settings'] as const;
type TabRoute = (typeof TAB_ROUTES)[number];

const TABS: Record<
  TabRoute,
  { icon: IconName; label: 'home' | 'visits' | 'subscriptions' | 'account'; testID: string }
> = {
  home: { icon: 'house', label: 'home', testID: 'tab-home' },
  visits: { icon: 'history', label: 'visits', testID: 'home-visits' },
  subscriptions: { icon: 'calendar-check', label: 'subscriptions', testID: 'tab-subscriptions' },
  settings: { icon: 'user', label: 'account', testID: 'home-settings' },
};

const isTab = (name: string): name is TabRoute => (TAB_ROUTES as readonly string[]).includes(name);

export function TabBar({ state, emitter, navigateToTab }: BottomTabBarProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space[2]) }]}
      accessibilityRole="tablist"
      accessibilityLabel={t.tabs.label}
    >
      <View style={styles.row}>
        {state.routes.map((route, index) => {
          if (!isTab(route.name)) return null;
          const tab = TABS[route.name];
          const focused = state.index === index;
          const label = t.tabs[tab.label];
          const tint = focused ? color.primaryText : color.textMuted;
          return (
            <Touchable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              // react-native-web reads the ARIA prop, not `accessibilityState`
              aria-selected={focused}
              accessibilityLabel={label}
              testID={tab.testID}
              feedback="select"
              pressScale={0.94}
              containerStyle={styles.item}
              style={styles.press}
              onPress={() => {
                const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigateToTab(route.key);
              }}
            >
              <Icon name={tab.icon} size={24} tint={tint} />
              <AppText
                center
                numberOfLines={1}
                style={[styles.label, { color: tint }, focused && styles.labelOn]}
              >
                {label}
              </AppText>
            </Touchable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: color.surface,
    borderTopWidth: 1,
    borderTopColor: color.border,
    paddingTop: space[2],
  },
  row: {
    flexDirection: 'row',
    width: '100%',
    maxWidth: layout.shellMaxW,
    alignSelf: 'center',
    minHeight: layout.bottomnavH - space[2],
  },
  item: { flex: 1 },
  press: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[0.5],
    minHeight: space[12],
    paddingHorizontal: space[1],
  },
  label: { ...fontSize.xs, fontFamily: font.medium },
  labelOn: { fontFamily: font.semibold },
});
