/**
 * C-12 pay area and its C-10-like sheet (V2-022 / V2-023; docs/v2/01 R4, C-10, C-12; DEC-521, DEC-524). A separate
 * component so the visit screen (C-12, another stream) mounts it with one line:
 *
 *   <PayDue ticketId={visit.ticket_id} amountHalalas={fee} onPaid={reload} />
 *
 * shown only while the visit's fee is due (entitlement `none`, not delivered). The sheet offers Apple Pay where a
 * native provider is given (a dev build with PassKit; `applePay` prop), the saved cards (C-18) and a new card typed
 * here and tokenized on the device with the gateway's publishable key (tokenize.ts) — the card never reaches POINT's
 * servers — with «حفظ البطاقة» (explicit `card_on_file` consent). The server decides the amount; this screen only
 * shows it. 3-D Secure opens in an in-app browser; the result comes from the server (payFlow.ts).
 *
 * V2-UX (DEC-579): the sheet rises from the bottom over a dimmed screen (rounded top, a grab handle), the total in a
 * summary block, the saved cards as selectable rows with a card icon and a tick, one primary «ادفع» button; once the
 * server confirms, a success mark springs in with the confirmation sentence and the sheet closes by itself a moment
 * later (the same `onPaid` as before). The pay area of C-12 is a card with the wallet icon and a secondary button.
 */
import type { CustomerPaymentMethod, CustomerPaymentSource } from '@point/shared/customer';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { appConfig } from '../../config';
import { isolate } from '../../i18n';
import { useI18n } from '../../i18n/I18nProvider';
import { newIdempotencyKey } from '../../session/secureStore';
import { useSession } from '../../session/SessionProvider';
import { color, font, fontSize, radius, space } from '../../theme/tokens';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card, Checkbox, IconBadge } from '../../ui/Controls';
import { Field } from '../../ui/Field';
import { haptic } from '../../ui/haptics';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { SuccessCheck } from '../../ui/SuccessCheck';
import { Touchable } from '../../ui/Touchable';
import { CommandKey } from '../commandKey';
import { formatCardNumber, formatExpiry, sar, validateCard, type CardIssue } from './card';
import { cardRow, orderCards } from './methods';
import { checkoutSubscription, payVisit, type PayOutcome, type SubscriptionCheckoutRequest } from './payFlow';
import { createCardTokenizer, TokenizeError } from './tokenize';

/** A native Apple Pay sheet (PassKit) handing over the payment token for the server; absent in Expo Go. */
export interface ApplePayProvider {
  available(): Promise<boolean>;
  /** shows the sheet for this amount; resolves with the opaque Apple Pay token, or null when cancelled */
  requestToken(amountHalalas: number, label: string): Promise<string | null>;
}

export interface PayDueProps {
  ticketId: string;
  /** the fee the server reported for the visit (VAT included); the server charges its own figure anyway */
  amountHalalas: number;
  onPaid?: () => void;
  applePay?: ApplePayProvider;
}

type Message = { tone: 'success' | 'danger' | 'warning' | 'info'; text: string };

export function PayDue({ ticketId, amountHalalas, onPaid, applePay }: PayDueProps) {
  const { t, f } = useI18n();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const amount = sar(amountHalalas);
  if (done)
    return (
      <Card>
        <View style={styles.row}>
          <IconBadge name="circle-check" size={40} tint={color.successText} bg={color.successSubtle} />
          <AppText variant="bodyStrong" tone="success">
            {t.pay.paidBadge}
          </AppText>
        </View>
      </Card>
    );
  return (
    <Card accent>
      <View style={styles.row}>
        <IconBadge name="wallet" size={44} />
        <View style={styles.flex}>
          <AppText variant="cardTitle" accessibilityRole="header">
            {f(t.pay.due, { amount })}
          </AppText>
          <AppText variant="small" tone="muted">
            {t.pay.vatIncluded}
          </AppText>
        </View>
      </View>
      <AppText variant="small" tone="muted">
        {t.pay.dueHint}
      </AppText>
      <Button
        label={f(t.pay.payNow, { amount })}
        icon="credit-card"
        variant="secondary"
        size="md"
        onPress={() => setOpen(true)}
        testID="pay-due-open"
      />
      <PaySheet
        visible={open}
        ticketId={ticketId}
        amountHalalas={amountHalalas}
        onClose={() => setOpen(false)}
        onPaid={() => {
          setDone(true);
          setOpen(false);
          onPaid?.();
        }}
        applePay={applePay}
      />
    </Card>
  );
}

/**
 * V2-032 (C-10 for a subscription): the sheet pays a subscription instead of a visit — the start command of the
 * checkout (subscribe, or pay a waiting one). The card is always kept for the automatic renewal (DEC-534): «حفظ
 * البطاقة» is on and fixed, Apple Pay is not offered.
 */
export interface SubscriptionSheetCheckout {
  start: SubscriptionCheckoutRequest['start'];
  /** the subscription the checkout created or paid (C-14 opens it) */
  onSubscription?: (subscriptionId: string | null) => void;
}

export function PaySheet({
  visible,
  ticketId,
  amountHalalas,
  onClose,
  onPaid,
  applePay,
  subscription,
  title,
}: {
  visible: boolean;
  /** the visit to pay (C-12); unused with `subscription` */
  ticketId?: string;
  amountHalalas: number;
  onClose: () => void;
  onPaid: () => void;
  applePay?: ApplePayProvider;
  subscription?: SubscriptionSheetCheckout;
  title?: string;
}) {
  const { t, f } = useI18n();
  const session = useSession();
  const [cards, setCards] = useState<CustomerPaymentMethod[]>([]);
  const [selected, setSelected] = useState<string | 'new'>('new');
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [name, setName] = useState('');
  const [save, setSave] = useState(!!subscription);
  const [issues, setIssues] = useState<CardIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [succeeded, setSucceeded] = useState<string | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [applePayReady, setApplePayReady] = useState(false);
  const [consentVersion, setConsentVersion] = useState(appConfig.payments.cardOnFileVersion);
  const key = useRef(new CommandKey(newIdempotencyKey)).current;
  const tokenize = useMemo(
    () => createCardTokenizer(appConfig, { callbackUrl: 'sa.point.app://pay/return' }),
    [],
  );
  const amount = sar(amountHalalas);
  const cardsAvailable = appConfig.api.mode === 'fake' || !!appConfig.payments.moyasarPublishableKey;

  useEffect(
    () => () => {
      if (closing.current) clearTimeout(closing.current);
    },
    [],
  );

  /** the server confirmed: the success mark, then the sheet closes by itself */
  const succeed = (text: string) => {
    haptic.success();
    setSucceeded(text);
    closing.current = setTimeout(() => {
      closing.current = null;
      onPaid();
    }, SUCCESS_MS);
  };

  useEffect(() => {
    if (!visible) return;
    setMessage(null);
    setSucceeded(null);
    session.api
      .paymentMethods()
      .then((list) => {
        const ordered = orderCards(list);
        setCards(ordered);
        setSelected(ordered[0]?.id ?? 'new');
      })
      .catch(() => setCards([]));
    if (!subscription && applePay && Platform.OS === 'ios' && appConfig.payments.applePayMerchantId)
      applePay.available().then(setApplePayReady, () => setApplePayReady(false));
  }, [visible, session.api, applePay, subscription]);

  const run = async (source: CustomerPaymentSource, saveCard: boolean, signature: string) => {
    setBusy(true);
    setMessage(null);
    const effects = {
      openAuthSession: (url: string, back: string) => WebBrowser.openAuthSessionAsync(url, back),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      now: Date.now,
    };
    let outcome: PayOutcome;
    if (subscription) {
      const result = await checkoutSubscription(
        { ...effects, api: session.api },
        {
          start: subscription.start,
          source,
          saveCard: source.type === 'token' ? true : saveCard,
          cardOnFileVersion: consentVersion,
          idempotencyKey: key.for(signature),
        },
      );
      subscription.onSubscription?.(result.subscriptionId ?? null);
      outcome = result;
    } else {
      outcome = await payVisit(
        { ...effects, api: session.api },
        {
          ticketId: ticketId ?? '',
          source,
          saveCard,
          cardOnFileVersion: consentVersion,
          idempotencyKey: key.for(signature),
        },
      );
    }
    setBusy(false);
    switch (outcome.kind) {
      case 'paid':
        key.reset();
        succeed(t.pay.paid);
        return;
      case 'already_paid':
        key.reset();
        succeed(t.pay.alreadyPaid);
        return;
      case 'pending':
        setMessage({ tone: 'info', text: t.pay.pending });
        return;
      case 'failed':
        key.reset();
        haptic.error();
        setMessage({ tone: 'danger', text: t.pay.failed });
        return;
      case 'in_progress':
        setMessage({ tone: 'warning', text: t.pay.inProgress });
        return;
      case 'not_payable':
        key.reset();
        setMessage({ tone: 'warning', text: t.pay.notPayable });
        return;
      case 'consent': {
        key.reset();
        if (outcome.currentVersion) setConsentVersion(outcome.currentVersion);
        setMessage({ tone: 'warning', text: t.pay.consent });
        return;
      }
      case 'card_required':
        key.reset();
        setMessage({ tone: 'warning', text: t.pay.cardRequired });
        return;
      case 'exists':
        key.reset();
        setMessage({ tone: 'warning', text: t.subscribe.exists });
        return;
      default:
        setMessage({ tone: 'danger', text: t.pay.failed });
    }
  };

  const payWithCard = async () => {
    if (selected !== 'new')
      return run({ type: 'saved', payment_method_id: selected }, false, `saved:${selected}`);
    const checked = validateCard({ number, expiry, cvc, name }, Date.now());
    setIssues(checked.issues);
    if (!checked.card) return;
    setBusy(true);
    try {
      const { token } = await tokenize(checked.card);
      // the card fields leave the screen's state as soon as the token exists
      setNumber('');
      setCvc('');
      await run({ type: 'token', token }, save, `token:${token}:${save}`);
    } catch (e) {
      setBusy(false);
      setMessage({
        tone: 'danger',
        text: e instanceof TokenizeError && e.kind === 'unavailable' ? t.pay.unavailable : t.pay.failed,
      });
    }
  };

  const payWithApplePay = async () => {
    if (!applePay) return;
    const token = await applePay.requestToken(amountHalalas, t.pay.sheetTitle).catch(() => null);
    if (token) await run({ type: 'applepay', token }, false, `applepay:${token.length}:${Date.now()}`);
  };

  return (
    <Sheet visible={visible} onRequestClose={busy || succeeded ? () => undefined : onClose}>
      {succeeded ? (
        <View style={styles.success} accessibilityLiveRegion="polite">
          <SuccessCheck />
          <AppText variant="title" center accessibilityRole="header">
            {title ?? t.pay.sheetTitle}
          </AppText>
          <AppText center tone="success" variant="bodyStrong">
            {succeeded}
          </AppText>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
          <AppText variant="title" accessibilityRole="header">
            {title ?? t.pay.sheetTitle}
          </AppText>
          <View style={styles.summary}>
            <IconBadge name="receipt" size={40} />
            <View style={styles.flex}>
              <AppText variant="small" tone="muted">
                {t.pay.total}
              </AppText>
              <AppText style={styles.amount}>{f(t.pay.amountLabel, { amount: isolate(amount) })}</AppText>
            </View>
            <AppText variant="caption" tone="muted" style={styles.vat}>
              {t.pay.vatIncluded}
            </AppText>
          </View>
          {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}

          {applePayReady ? (
            <Button label={t.pay.applePay} onPress={() => void payWithApplePay()} disabled={busy} />
          ) : null}

          {cards.length > 0 ? (
            <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={t.pay.savedCards}>
              <AppText variant="label">{t.pay.savedCards}</AppText>
              {cards.map((c) => {
                const row = cardRow(c, t);
                const on = selected === c.id;
                return (
                  <Touchable
                    key={c.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => setSelected(c.id)}
                    feedback="select"
                    pressScale={0.99}
                    style={[styles.option, on && styles.optionOn]}
                  >
                    <Icon name="credit-card" size={22} tint={on ? color.primaryText : color.textMuted} />
                    <View style={styles.flex}>
                      <AppText variant="bodyStrong">{row.title}</AppText>
                      {row.expires ? (
                        <AppText variant="small" tone="muted">
                          {row.expires}
                        </AppText>
                      ) : null}
                    </View>
                    <View style={[styles.tick, on && styles.tickOn]}>
                      {on ? <Icon name="check" size={14} tint={color.onPrimary} strokeWidth={3} /> : null}
                    </View>
                  </Touchable>
                );
              })}
              <Touchable
                accessibilityRole="radio"
                accessibilityState={{ selected: selected === 'new' }}
                onPress={() => setSelected('new')}
                feedback="select"
                pressScale={0.99}
                style={[styles.option, selected === 'new' && styles.optionOn]}
              >
                <Icon name="plus" size={22} tint={selected === 'new' ? color.primaryText : color.textMuted} />
                <View style={styles.flex}>
                  <AppText variant="bodyStrong">{t.pay.newCard}</AppText>
                </View>
                <View style={[styles.tick, selected === 'new' && styles.tickOn]}>
                  {selected === 'new' ? (
                    <Icon name="check" size={14} tint={color.onPrimary} strokeWidth={3} />
                  ) : null}
                </View>
              </Touchable>
            </View>
          ) : null}

          {selected === 'new' ? (
            cardsAvailable ? (
              <View style={styles.group}>
                <Field
                  label={t.pay.cardNumber}
                  testID="card-number"
                  value={number}
                  onChangeText={(v) => setNumber(formatCardNumber(v))}
                  keyboardType="number-pad"
                  autoComplete="cc-number"
                  textContentType="creditCardNumber"
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
                <Checkbox
                  label={subscription ? t.pay.saveForRenewal : t.pay.saveCard}
                  checked={save}
                  onChange={subscription ? () => setSave(true) : setSave}
                  detail={
                    <AppText variant="small" tone="muted">
                      {subscription ? t.pay.saveForRenewalDetail : t.pay.saveCardDetail}
                    </AppText>
                  }
                />
              </View>
            ) : (
              <Banner tone="warning">{t.pay.unavailable}</Banner>
            )
          ) : null}

          <View style={styles.row}>
            <Icon name="shield-check" size={18} tint={color.successText} />
            <AppText variant="small" tone="muted" style={styles.flex}>
              {t.pay.secureNote}
            </AppText>
          </View>
          <Button
            label={f(t.pay.payNow, { amount })}
            loading={busy}
            loadingLabel={t.pay.paying}
            disabled={selected === 'new' && !cardsAvailable}
            onPress={() => void payWithCard()}
            testID="pay-sheet-submit"
            icon="credit-card"
          />
          <Button label={t.pay.cancel} variant="ghost" size="md" onPress={onClose} disabled={busy} />
        </ScrollView>
      )}
    </Sheet>
  );
}

/** How long the success mark stays before the sheet closes by itself (DEC-579). */
const SUCCESS_MS = 1400;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  sheetBody: { padding: space[4], paddingTop: space[2], gap: space[3] },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[3],
    borderRadius: radius.lg,
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.border,
  },
  amount: { fontFamily: font.bold, ...fontSize['2xl'], color: color.text },
  vat: { maxWidth: 96 },
  success: { alignItems: 'center', gap: space[3], padding: space[8], paddingBottom: space[12] },
  group: { gap: space[2] },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    padding: space[3],
    minHeight: 56,
  },
  optionOn: { borderColor: color.primary, borderWidth: 2, backgroundColor: color.primarySubtle },
  tick: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { backgroundColor: color.primary, borderColor: color.primary },
});
