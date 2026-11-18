/**
 * C-18 وسائل الدفع (V2-023, DEC-524): the saved cards (network, last four digits, expiry — the token stays on the
 * server), «اجعلها الافتراضية», «حذف» after a confirmation (the token is deleted at the gateway too), and «أضف
 * بطاقة»: typed here, tokenized on the device with the publishable key (`save_only`), saved with the explicit
 * `card_on_file` consent. One Idempotency-Key per command.
 */
import type { CustomerPaymentMethod } from '@point/shared/customer';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { appConfig } from '../config';
import { errorText } from '../features/errorText';
import { formatCardNumber, formatExpiry, validateCard, type CardIssue } from '../features/pay/card';
import { cardGone, cardRow, consentVersionFrom, orderCards } from '../features/pay/methods';
import { createCardTokenizer } from '../features/pay/tokenize';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { font, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, Card, Checkbox } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { Field } from '../ui/Field';
import { Screen } from '../ui/Screen';
import { SkeletonList } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { ScreenHeader } from '../ui/ScreenHeader';

type Message = { tone: 'success' | 'danger' | 'warning'; text: string };

export default function PaymentMethods() {
  const { t, f, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [items, setItems] = useState<CustomerPaymentMethod[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [adding, setAdding] = useState(false);
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [issues, setIssues] = useState<CardIssue[]>([]);
  const [consentVersion, setConsentVersion] = useState(appConfig.payments.cardOnFileVersion);
  const tokenize = useMemo(
    () => createCardTokenizer(appConfig, { callbackUrl: 'sa.point.app://pay/return' }),
    [],
  );

  const load = useCallback(async () => {
    try {
      setItems(orderCards(await session.api.paymentMethods()));
    } catch (e) {
      setMessage({ tone: 'danger', text: `${t.paymentMethods.loadFailed} ${errorText(e, t, locale)}` });
    }
  }, [session.api, t, locale]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: 'success', text: done });
    } catch (e) {
      setMessage({ tone: cardGone(e) ? 'warning' : 'danger', text: errorText(e, t, locale) });
    } finally {
      setBusy(null);
      await load();
    }
  };

  const confirmRemove = (c: CustomerPaymentMethod) =>
    Alert.alert(t.paymentMethods.confirmTitle, f(t.paymentMethods.confirmBody, { last4: c.last4 ?? '' }), [
      { text: t.pay.cancel, style: 'cancel' },
      {
        text: t.paymentMethods.confirm,
        style: 'destructive',
        onPress: () =>
          void act(
            c.id,
            () => session.api.removePaymentMethod(c.id, newIdempotencyKey()),
            t.paymentMethods.removed,
          ),
      },
    ]);

  const add = async () => {
    const checked = validateCard({ number, expiry, cvc, name }, Date.now());
    setIssues(checked.issues);
    if (!checked.card || !consent) return;
    setBusy('add');
    setMessage(null);
    try {
      const { token } = await tokenize(checked.card);
      setNumber('');
      setCvc('');
      await session.api.addPaymentMethod(
        { token, card_on_file_version: consentVersion },
        newIdempotencyKey(),
      );
      setAdding(false);
      setMessage({ tone: 'success', text: t.paymentMethods.added });
    } catch (e) {
      const v = consentVersionFrom(e);
      if (v) {
        setConsentVersion(v);
        setConsent(false);
        setMessage({ tone: 'warning', text: t.pay.consent });
      } else setMessage({ tone: 'danger', text: errorText(e, t, locale) });
    } finally {
      setBusy(null);
      await load();
    }
  };

  return (
    <Screen
      footer={
        items && !adding ? <Button label={t.paymentMethods.add} onPress={() => setAdding(true)} /> : undefined
      }
    >
      <ScreenHeader
        title={t.paymentMethods.title}
        backLabel={t.paymentMethods.back}
        onBack={() => router.back()}
      />
      <DevBanner />
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      <AppText variant="small" tone="muted">
        {t.paymentMethods.note}
      </AppText>
      {!items ? <SkeletonList label={t.common.loading} count={2} avatar /> : null}
      {items && items.length === 0 && !adding ? (
        <EmptyState icon="credit-card" text={t.paymentMethods.empty} />
      ) : null}
      {items?.map((c) => {
        const row = cardRow(c, t);
        return (
          <Card key={row.id} accent={row.isDefault}>
            <AppText style={styles.card}>{row.title}</AppText>
            {row.expires ? <AppText tone="muted">{row.expires}</AppText> : null}
            {row.isDefault ? (
              <AppText variant="small" tone="primary">
                {t.paymentMethods.default}
              </AppText>
            ) : (
              <Button
                label={t.paymentMethods.makeDefault}
                variant="secondary"
                size="md"
                loading={busy === `default:${row.id}`}
                disabled={busy !== null}
                onPress={() =>
                  void act(
                    `default:${row.id}`,
                    () => session.api.setDefaultPaymentMethod(row.id, newIdempotencyKey()),
                    t.paymentMethods.default,
                  )
                }
              />
            )}
            <Button
              label={t.paymentMethods.remove}
              variant="ghost"
              size="md"
              loading={busy === row.id}
              disabled={busy !== null && busy !== row.id}
              onPress={() => confirmRemove(c)}
            />
          </Card>
        );
      })}
      {adding ? (
        <Card>
          <View style={styles.form}>
            <Field
              label={t.pay.cardNumber}
              testID="card-number"
              value={number}
              onChangeText={(v) => setNumber(formatCardNumber(v))}
              keyboardType="number-pad"
              ltr
              error={issues.includes('number') ? t.pay.issues.number : null}
            />
            <Field
              label={t.pay.expiry}
              testID="card-expiry"
              value={expiry}
              onChangeText={(v) => setExpiry(formatExpiry(v))}
              keyboardType="number-pad"
              ltr
              error={
                issues.includes('expired')
                  ? t.pay.issues.expired
                  : issues.includes('expiry')
                    ? t.pay.issues.expiry
                    : null
              }
            />
            <Field
              label={t.pay.cvc}
              testID="card-cvc"
              value={cvc}
              onChangeText={(v) => setCvc(v.replace(/[^0-9٠-٩]/g, '').slice(0, 4))}
              keyboardType="number-pad"
              secureTextEntry
              ltr
              error={issues.includes('cvc') ? t.pay.issues.cvc : null}
            />
            <Field
              label={t.pay.cardName}
              testID="card-name"
              value={name}
              onChangeText={setName}
              autoCapitalize="characters"
              ltr
              error={issues.includes('name') ? t.pay.issues.name : null}
            />
            <Checkbox label={t.paymentMethods.consent} checked={consent} onChange={setConsent} />
            <Button
              label={t.paymentMethods.save}
              loading={busy === 'add'}
              loadingLabel={t.common.saving}
              disabled={!consent}
              onPress={() => void add()}
            />
            <Button label={t.pay.cancel} variant="ghost" size="md" onPress={() => setAdding(false)} />
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { fontFamily: font.semibold },
  form: { gap: space[2] },
});
