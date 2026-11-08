/**
 * C-04 الاسم والموافقات: the name, terms and privacy (required, with their version and a link to the text) and
 * marketing (optional, separate, never pre-ticked). The answers are stored append-only with the version shown
 * (`customer_account_consents`); the server then says whether the profile is complete.
 */
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { CustomerConsentState } from '@point/shared/customer';
import { isApiError } from '../api/errors';
import { CommandKey } from '../features/commandKey';
import { errorText } from '../features/errorText';
import {
  hasErrors,
  initialProfileForm,
  profileRequests,
  validateProfile,
  type ProfileForm,
} from '../features/profile';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, Card, Checkbox } from '../ui/Controls';
import { Field } from '../ui/Field';
import { Screen } from '../ui/Screen';

export default function Profile() {
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const me = session.me;
  const [form, setForm] = useState<ProfileForm>(() =>
    me ? initialProfileForm(me) : { name: '', terms: false, privacy: false, marketing: false },
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const patchKey = useRef(new CommandKey(newIdempotencyKey)).current;
  const consentKey = useRef(new CommandKey(newIdempotencyKey)).current;

  if (!me) return null;
  const errors = validateProfile(form);
  const set = (patch: Partial<ProfileForm>) => setForm((p) => ({ ...p, ...patch }));

  const submit = async () => {
    setSubmitted(true);
    if (hasErrors(errors) || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const { patch, consents } = profileRequests(form, me);
      let latest = me;
      if (patch) {
        latest = await session.api.updateMe(patch, patchKey.for(JSON.stringify(patch)));
        patchKey.reset();
      }
      if (consents) {
        latest = await session.api.submitConsents(consents, consentKey.for(JSON.stringify(consents)));
        consentKey.reset();
      }
      router.replace(await session.setMe(latest));
    } catch (e) {
      if (isApiError(e, 'CUSTOMER_CONSENT_VERSION_STALE')) {
        // the owner published a new text meanwhile: reload it and ask again
        const fresh = await session.api.me().catch(() => me);
        await session.setMe(fresh);
        setForm((p) => ({ ...initialProfileForm(fresh), name: p.name }));
        setFailure(t.profile.stale);
      } else {
        setFailure(errorText(e, t, locale));
      }
    } finally {
      setBusy(false);
    }
  };

  const link = (state: CustomerConsentState) => (
    <View style={styles.meta}>
      <AppText variant="small" tone="muted">
        {f(t.profile.version, { version: state.current_version })}
      </AppText>
      {state.document_url ? (
        <Pressable
          accessibilityRole="link"
          hitSlop={12}
          onPress={() => void WebBrowser.openBrowserAsync(state.document_url as string)}
        >
          <AppText variant="small" tone="primary">
            {t.profile.read}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <Screen
      footer={
        <Button
          label={t.profile.submit}
          loading={busy}
          loadingLabel={t.common.saving}
          onPress={submit}
          testID="profile-submit"
        />
      }
    >
      <AppText variant="title" accessibilityRole="header">
        {t.profile.title}
      </AppText>
      <Field
        label={t.profile.nameLabel}
        testID="profile-name"
        value={form.name}
        onChangeText={(name) => set({ name })}
        placeholder={t.profile.namePlaceholder}
        textContentType="name"
        autoComplete="name"
        maxLength={60}
        error={submitted && errors.name ? t.profile.nameInvalid : null}
      />
      <Card>
        <Checkbox
          label={t.profile.terms}
          checked={form.terms}
          onChange={(terms) => set({ terms })}
          detail={link(me.consents.terms)}
        />
        <Checkbox
          label={t.profile.privacy}
          checked={form.privacy}
          onChange={(privacy) => set({ privacy })}
          detail={link(me.consents.privacy)}
        />
      </Card>
      <Card>
        <Checkbox
          label={`${t.profile.marketing} (${t.common.optional})`}
          checked={form.marketing}
          onChange={(marketing) => set({ marketing })}
          detail={link(me.consents.marketing)}
        />
      </Card>
      {submitted && errors.consents ? <Banner tone="danger">{t.profile.requiredMissing}</Banner> : null}
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', gap: space[3], paddingStart: space[8] + space[1] },
});
