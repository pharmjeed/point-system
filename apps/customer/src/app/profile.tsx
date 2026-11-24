/**
 * C-04 (owner's option 4, DEC-637): a blue welcome card («أهلًا بك! تم التحقق من رقمك. بقي اسمك فقط»), the name,
 * marketing (optional, separate, never pre-ticked) and, above «ابدأ», the line «بالضغط على «ابدأ» توافق على الشروط
 * وسياسة الخصوصية» with both texts linked (the terms on C-24 in the app, DEC-614). Pressing «ابدأ» is the consent:
 * terms and privacy are still stored one by one, append-only, with the version shown (`customer_account_consents`);
 * the server then says whether the profile is complete. A returning customer sent here by a new version of a text
 * is greeted by name and told why.
 */
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useRef, useState } from 'react';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { StyleSheet, View } from 'react-native';
import { isApiError } from '../api/errors';
import { CommandKey } from '../features/commandKey';
import { errorText } from '../features/errorText';
import {
  acceptRequired,
  hasErrors,
  initialProfileForm,
  profileRequests,
  validateProfile,
  type ProfileForm,
} from '../features/profile';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { color, radius, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, Checkbox } from '../ui/Controls';
import { Field } from '../ui/Field';
import { Icon } from '../ui/Icon';
import { Screen } from '../ui/Screen';
import { StepDots } from '../ui/StepHeader';
import { Touchable } from '../ui/Touchable';

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
  // «ابدأ» is the consent to the terms and the privacy policy (DEC-637)
  const accepted = acceptRequired(form);
  const errors = validateProfile(accepted);
  const set = (patch: Partial<ProfileForm>) => setForm((p) => ({ ...p, ...patch }));

  const submit = async () => {
    setSubmitted(true);
    if (hasErrors(errors) || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const { patch, consents } = profileRequests(accepted, me);
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

  const returning = !!me.display_name;
  const privacyUrl = me.consents.privacy.document_url;
  const openTerms = () => router.push('/terms');
  const openPrivacy = privacyUrl ? () => void WebBrowser.openBrowserAsync(privacyUrl) : null;

  return (
    <Screen
      footer={
        <>
          <View style={styles.agree}>
            <AppText variant="small" tone="muted">
              {t.profile.agree.before}
            </AppText>
            <TextLink label={t.profile.agree.terms} onPress={openTerms} testID="profile-terms-link" />
            {/* Arabic «و» is written joined to the next word; English keeps its space */}
            <View style={[styles.joined, { columnGap: locale === 'ar' ? 0 : space[1] }]}>
              <AppText variant="small" tone="muted">
                {t.profile.agree.between}
              </AppText>
              {openPrivacy ? (
                <TextLink
                  label={t.profile.agree.privacy}
                  onPress={openPrivacy}
                  testID="profile-privacy-link"
                />
              ) : (
                <AppText variant="small" tone="muted">
                  {t.profile.agree.privacy}
                </AppText>
              )}
            </View>
          </View>
          <Button
            label={t.profile.submit}
            icon="go"
            loading={busy}
            loadingLabel={t.common.saving}
            onPress={submit}
            testID="profile-submit"
          />
        </>
      }
    >
      <StepDots step={3} />
      <View style={styles.hello}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none" accessible={false} aria-hidden>
          <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
            <Defs>
              <LinearGradient id="profile-sky" x1="0" y1="0" x2="0.8" y2="1">
                <Stop offset="0" stopColor={color.focus} />
                <Stop offset="0.45" stopColor={color.primary} />
                <Stop offset="1" stopColor={color.primaryPressed} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="100" height="100" fill="url(#profile-sky)" />
          </Svg>
        </View>
        <Icon name="hand" size={34} tint={color.onPrimary} strokeWidth={1.8} />
        <AppText variant="title" tone="inverse" accessibilityRole="header">
          {returning ? f(t.profile.titleBack, { name: me.display_name ?? '' }) : t.profile.title}
        </AppText>
        <AppText tone="inverse" style={styles.helloHint}>
          {returning ? t.profile.hintBack : t.profile.hint}
        </AppText>
      </View>
      <Field
        label={t.profile.nameLabel}
        testID="profile-name"
        value={form.name}
        onChangeText={(name) => set({ name })}
        placeholder={t.profile.namePlaceholder}
        textContentType="name"
        autoComplete="name"
        maxLength={60}
        large
        error={submitted && errors.name ? t.profile.nameInvalid : null}
      />
      <Checkbox
        label={`${t.profile.marketing} (${t.common.optional})`}
        checked={form.marketing}
        onChange={(marketing) => set({ marketing })}
      />
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
    </Screen>
  );
}

/** A word of the agreement line that opens its text: a 44-point target around the word (DEC-575). */
function TextLink({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return (
    <Touchable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      pressScale={1}
      testID={testID}
      style={styles.link}
    >
      <AppText variant="smallStrong" tone="primary">
        {label}
      </AppText>
    </Touchable>
  );
}

const styles = StyleSheet.create({
  hello: {
    gap: space[2],
    padding: space[5],
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: color.primary,
  },
  helloHint: { opacity: 0.9 },
  agree: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: space[1],
  },
  joined: { flexDirection: 'row', alignItems: 'center' },
  link: { minHeight: 44, justifyContent: 'center' },
});
