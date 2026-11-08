/**
 * C-19 الإعدادات (V2-017): language (kept on the device and sent to the account, so WhatsApp and push follow it;
 * the direction follows on the next launch, DEC-509), notifications (V2-016: on/off for this device, or why not), «تواصل معنا» from
 * the configuration, the terms and privacy pages the API names, the app version, sign out and «حذف الحساب» (C-20).
 */
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { appConfig } from '../config';
import { CommandKey } from '../features/commandKey';
import { errorText } from '../features/errorText';
import { pushSettingState } from '../features/push';
import { settingsView, type LinkItem } from '../features/settings';
import { usePush } from '../push/usePush';
import { dictionaries, isolate, type AppLocale } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, Card, ChoiceChips } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { openLink } from '../ui/openLinks';
import { Screen } from '../ui/Screen';
import { ScreenHeader } from '../ui/ScreenHeader';

export default function Settings() {
  const { t, f, locale, setLocale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState<'locale' | 'signout' | 'push' | null>(null);
  const push = usePush(t.visit.title);
  const pushState = pushSettingState(push.state);
  const key = useRef(new CommandKey(newIdempotencyKey)).current;
  const view = settingsView(session.me, appConfig, t);

  const changeLocale = async (next: AppLocale | null) => {
    if (!next || next === locale || busy) return;
    setBusy('locale');
    setMessage(null);
    try {
      await setLocale(next);
      setMessage({ tone: 'success', text: dictionaries[next].settings.languageSaved });
      // the account's language (WhatsApp templates, later push): best effort, the device keeps its choice anyway
      const body = { locale: next };
      const me = await session.api.updateMe(body, key.for(JSON.stringify(body)));
      key.reset();
      await session.setMe(me);
    } catch (e) {
      setMessage({ tone: 'warning', text: errorText(e, t, locale) });
    } finally {
      setBusy(null);
    }
  };

  const togglePush = async () => {
    setBusy('push');
    setMessage(null);
    try {
      if (pushState === 'on') {
        await push.disable();
        setMessage({ tone: 'success', text: t.push.disabled });
      } else {
        const r = await push.enable();
        setMessage(
          r === 'enabled'
            ? { tone: 'success', text: t.push.enabled }
            : r === 'denied'
              ? { tone: 'warning', text: t.push.blocked }
              : { tone: 'warning', text: t.push.unavailable },
        );
      }
    } catch (e) {
      setMessage({ tone: 'warning', text: `${t.push.failed} ${errorText(e, t, locale)}` });
    } finally {
      setBusy(null);
    }
  };

  const open = async (link: LinkItem) => {
    setMessage(null);
    if (!(await openLink(link.url))) setMessage({ tone: 'warning', text: t.settings.openFailed });
  };

  const signOut = async () => {
    setBusy('signout');
    await session.signOut();
    router.replace('/phone');
  };

  return (
    <Screen>
      <ScreenHeader title={t.settings.title} backLabel={t.settings.back} onBack={() => router.back()} />
      <DevBanner />
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}

      <Card>
        <ChoiceChips<AppLocale>
          label={t.settings.language}
          options={view.languages}
          value={locale}
          onChange={(next) => void changeLocale(next)}
        />
      </Card>

      <Card>
        <AppText variant="cardTitle" accessibilityRole="header">
          {t.settings.notifications}
        </AppText>
        <AppText tone="muted">{t.push[pushState]}</AppText>
        {pushState === 'on' || pushState === 'off' ? (
          <Button
            label={pushState === 'on' ? t.push.disable : t.push.enable}
            variant="secondary"
            size="md"
            loading={busy === 'push'}
            loadingLabel={t.common.saving}
            onPress={() => void togglePush()}
            testID="settings-push"
          />
        ) : null}
        {pushState === 'blocked' ? (
          <Button
            label={t.push.openSettings}
            variant="ghost"
            size="md"
            onPress={() => void Linking.openSettings()}
          />
        ) : null}
      </Card>

      <Card>
        <AppText variant="cardTitle" accessibilityRole="header">
          {t.settings.support}
        </AppText>
        {view.support.length === 0 ? <AppText tone="muted">{t.settings.supportNone}</AppText> : null}
        {view.support.map((l) => (
          <Button key={l.key} label={l.label} variant="secondary" size="md" onPress={() => void open(l)} />
        ))}
      </Card>

      <Card>
        <AppText variant="cardTitle" accessibilityRole="header">
          {t.settings.documents}
        </AppText>
        {view.documents.length === 0 ? <AppText tone="muted">{t.settings.documentsNone}</AppText> : null}
        {view.documents.map((l) => (
          <Button key={l.key} label={l.label} variant="ghost" size="md" onPress={() => void open(l)} />
        ))}
      </Card>

      <View style={styles.actions}>
        <Button
          label={t.settings.signOut}
          variant="secondary"
          size="md"
          loading={busy === 'signout'}
          loadingLabel={t.common.loading}
          onPress={() => void signOut()}
        />
        <Button
          label={t.settings.deleteAccount}
          variant="ghost"
          size="md"
          onPress={() => router.push('/delete-account')}
          testID="settings-delete-account"
        />
        <AppText variant="small" tone="muted" center>
          {f(t.settings.version, { version: isolate(view.version) })}
        </AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({ actions: { gap: space[2], paddingTop: space[2] } });
