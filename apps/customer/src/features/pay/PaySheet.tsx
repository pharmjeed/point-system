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
 */
import type { CustomerPaymentMethod, CustomerPaymentSource } from '@point/shared/customer';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { appConfig } from '../../config';
import { isolate } from '../../i18n';
import { useI18n } from '../../i18n/I18nProvider';
import { newIdempotencyKey } from '../../session/secureStore';
import { useSession } from '../../session/SessionProvider';
import { color, radius, space } from '../../theme/tokens';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card, Checkbox } from '../../ui/Controls';
import { Field } from '../../ui/Field';
import { CommandKey } from '../commandKey';
import { formatCardNumber, formatExpiry, sar, validateCard, type CardIssue } from './card';
import { cardRow, orderCards } from './methods';
import { payVisit, type PayOutcome } from './payFlow';
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
        <AppText variant="bodyStrong" tone="success">
          {t.pay.paidBadge}
        </AppText>
      </Card>
    );
  return (
    <Card accent>
      <AppText variant="cardTitle" accessibilityRole="header">
        {f(t.pay.due, { amount })}
      </AppText>
      <AppText variant="small" tone="muted">
        {t.pay.vatIncluded}
      </AppText>
      <AppText tone="muted">{t.pay.dueHint}</AppText>
      <Button label={f(t.pay.payNow, { amount })} onPress={() => setOpen(true)} testID="pay-due-open" />
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

export function PaySheet({
  visible,
  ticketId,
  amountHalalas,
  onClose,
  onPaid,
  applePay,
}: {
  visible: boolean;
  ticketId: string;
  amountHalalas: number;
  onClose: () => void;
  onPaid: () => void;
  applePay?: ApplePayProvider;
}) {
  const { t, f } = useI18n();
  const session = useSession();
  const [cards, setCards] = useState<CustomerPaymentMethod[]>([]);
  const [selected, setSelected] = useState<string | 'new'>('new');
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [name, setName] = useState('');
  const [save, setSave] = useState(false);
  const [issues, setIssues] = useState<CardIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [applePayReady, setApplePayReady] = useState(false);
  const [consentVersion, setConsentVersion] = useState(appConfig.payments.cardOnFileVersion);
  const key = useRef(new CommandKey(newIdempotencyKey)).current;
  const tokenize = useMemo(
    () => createCardTokenizer(appConfig, { callbackUrl: 'sa.point.app://pay/return' }),
    [],
  );
  const amount = sar(amountHalalas);
  const cardsAvailable = appConfig.api.mode === 'fake' || !!appConfig.payments.moyasarPublishableKey;

  useEffect(() => {
    if (!visible) return;
    setMessage(null);
    session.api
      .paymentMethods()
      .then((list) => {
        const ordered = orderCards(list);
        setCards(ordered);
        setSelected(ordered[0]?.id ?? 'new');
      })
      .catch(() => setCards([]));
    if (applePay && Platform.OS === 'ios' && appConfig.payments.applePayMerchantId)
      applePay.available().then(setApplePayReady, () => setApplePayReady(false));
  }, [visible, session.api, applePay]);

  const run = async (source: CustomerPaymentSource, saveCard: boolean, signature: string) => {
    setBusy(true);
    setMessage(null);
    const outcome: PayOutcome = await payVisit(
      {
        api: session.api,
        openAuthSession: (url, back) => WebBrowser.openAuthSessionAsync(url, back),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
      },
      {
        ticketId,
        source,
        saveCard,
        cardOnFileVersion: consentVersion,
        idempotencyKey: key.for(signature),
      },
    );
    setBusy(false);
    switch (outcome.kind) {
      case 'paid':
        key.reset();
        setMessage({ tone: 'success', text: t.pay.paid });
        onPaid();
        return;
      case 'already_paid':
        key.reset();
        setMessage({ tone: 'success', text: t.pay.alreadyPaid });
        onPaid();
        return;
      case 'pending':
        setMessage({ tone: 'info', text: t.pay.pending });
        return;
      case 'failed':
        key.reset();
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
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={styles.backdrop} keyboardShouldPersistTaps="handled">
        <View style={styles.sheet} accessibilityViewIsModal>
          <AppText variant="title" accessibilityRole="header">
            {t.pay.sheetTitle}
          </AppText>
          <AppText variant="bodyStrong">
            {t.pay.total}: {f(t.pay.amountLabel, { amount: isolate(amount) })}
          </AppText>
          <AppText variant="small" tone="muted">
            {t.pay.vatIncluded}
          </AppText>
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
                  <Pressable
                    key={c.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => setSelected(c.id)}
                    style={[styles.option, on && styles.optionOn]}
                  >
                    <AppText variant="bodyStrong">{row.title}</AppText>
                    {row.expires ? <AppText tone="muted">{row.expires}</AppText> : null}
                  </Pressable>
                );
              })}
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: selected === 'new' }}
                onPress={() => setSelected('new')}
                style={[styles.option, selected === 'new' && styles.optionOn]}
              >
                <AppText variant="bodyStrong">{t.pay.newCard}</AppText>
              </Pressable>
            </View>
          ) : null}

          {selected === 'new' ? (
            cardsAvailable ? (
              <View style={styles.group}>
                <Field
                  label={t.pay.cardNumber}
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
                  value={cvc}
                  onChangeText={(v) => setCvc(v.replace(/[^0-9٠-٩]/g, '').slice(0, 4))}
                  keyboardType="number-pad"
                  secureTextEntry
                  ltr
                  error={issues.includes('cvc') ? t.pay.issues.cvc : null}
                />
                <Field
                  label={t.pay.cardName}
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="characters"
                  ltr
                  error={issues.includes('name') ? t.pay.issues.name : null}
                />
                <Checkbox
                  label={t.pay.saveCard}
                  checked={save}
                  onChange={setSave}
                  detail={
                    <AppText variant="small" tone="muted">
                      {t.pay.saveCardDetail}
                    </AppText>
                  }
                />
              </View>
            ) : (
              <Banner tone="warning">{t.pay.unavailable}</Banner>
            )
          ) : null}

          <AppText variant="small" tone="muted">
            {t.pay.secureNote}
          </AppText>
          <Button
            label={f(t.pay.payNow, { amount })}
            loading={busy}
            loadingLabel={t.pay.paying}
            disabled={selected === 'new' && !cardsAvailable}
            onPress={() => void payWithCard()}
            testID="pay-sheet-submit"
          />
          <Button label={t.pay.cancel} variant="ghost" size="md" onPress={onClose} disabled={busy} />
        </View>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: color.surface },
  sheet: { padding: space[4], gap: space[3] },
  group: { gap: space[2] },
  option: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    padding: space[3],
    minHeight: 48,
    gap: space[1],
  },
  optionOn: { borderColor: color.primary, borderWidth: 2 },
});
