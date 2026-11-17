/**
 * C-22 «شكوى جديدة» (V2-037; docs/v2/01 C-22; DEC-603): the type, the details (10 … 2000 characters, never a card
 * number), and optionally the subscription it is about. The server answers with the reference number at once
 * (`PT-C-000123`), shown back on C-21.
 */
import type { ComplaintCategory, CustomerSubscription } from '@point/shared/customer';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { complaintCategories, complaintIssue } from '../features/annex';
import { errorText } from '../features/errorText';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, ChoiceChips } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { Field } from '../ui/Field';
import { Screen } from '../ui/Screen';
import { ScreenHeader } from '../ui/ScreenHeader';

export default function ComplaintNew() {
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [category, setCategory] = useState<ComplaintCategory | null>(null);
  const [body, setBody] = useState('');
  const [about, setAbout] = useState<string | null>(null);
  const [subs, setSubs] = useState<CustomerSubscription[]>([]);
  const [issue, setIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      session.api.subscriptions().then(setSubs, () => setSubs([]));
    }, [session.api]),
  );

  const submit = async () => {
    const problem = !category ? t.annex.complaintCategoryNeeded : complaintIssue(body, t);
    setIssue(problem);
    if (problem || !category) return;
    setBusy(true);
    try {
      const c = await session.api.createComplaint(
        { category, body: body.trim(), ...(about ? { subscription_id: about } : {}) },
        newIdempotencyKey(),
      );
      router.replace({ pathname: '/complaints', params: { sent: c.reference } });
    } catch (e) {
      setIssue(errorText(e, t, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      footer={
        <Button
          label={t.annex.complaintSubmit}
          icon="message-warning"
          loading={busy}
          onPress={() => void submit()}
          testID="complaint-submit"
        />
      }
    >
      <ScreenHeader title={t.annex.newComplaint} backLabel={t.common.back} onBack={() => router.back()} />
      <DevBanner />
      <ChoiceChips
        label={t.annex.complaintCategory}
        options={complaintCategories(t)}
        value={category}
        onChange={setCategory}
      />
      {subs.length > 0 ? (
        <ChoiceChips
          label={t.annex.complaintAbout}
          options={subs.map((s) => ({
            value: s.subscription_id,
            label: locale === 'en' && s.venue_name_en ? s.venue_name_en : s.venue_name_ar,
          }))}
          value={about}
          onChange={setAbout}
        />
      ) : null}
      <Field
        label={t.annex.complaintBody}
        value={body}
        onChangeText={(v) => setBody(v.slice(0, 2000))}
        multiline
        numberOfLines={5}
        hint={t.annex.complaintBodyHint}
        testID="complaint-body"
      />
      <AppText variant="small" tone="muted">
        {t.annex.complaintsHint}
      </AppText>
      {issue ? <Banner tone="warning">{issue}</Banner> : null}
    </Screen>
  );
}
