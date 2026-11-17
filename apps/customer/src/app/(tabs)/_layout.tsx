/**
 * The signed-in area's tabs (V2-UX option B «البطاقة الحية», DEC-582): C-06 الرئيسية, C-16 زياراتي, C-14 اشتراكاتي
 * and C-19 حسابي under one bottom bar (`TabBar`). The group `(tabs)` adds nothing to the paths — `/home`, `/visits`,
 * `/subscriptions` and `/settings` stay what they were for the redirects of R1, the links and the notifications. Every
 * other screen is a stack screen above the tabs (the root `Stack`), so C-12, C-11, the pay and subscribe flows and
 * sign-in are full screen without the bar.
 */
import { Tabs } from 'expo-router/js-tabs';
import { color } from '../../theme/tokens';
import { TabBar } from '../../ui/TabBar';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.bg } }}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="visits" />
      <Tabs.Screen name="subscriptions" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
