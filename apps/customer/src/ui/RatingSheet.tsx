/**
 * C-13 قيّم الخدمة (V2-015, DEC-518): a bottom sheet after the delivery — 1–5 stars (each a 44-point target with its
 * number read out, never colour alone) and an optional note; «تخطَّ» closes it. One Idempotency-Key per sending.
 * V2-UX (DEC-579): the shared bottom `Sheet`, Lucide stars filled in amber up to the choice (the `warning` role:
 * brand §4.2's amber, decorative next to each star's number) with a selection haptic.
 */
import { CUSTOMER_RATING_NOTE_MAX } from '@point/shared/customer';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ApiError } from '../api/errors';
import { CommandKey } from '../features/commandKey';
import { errorText } from '../features/errorText';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { color, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { Button } from './Button';
import { Banner, IconBadge } from './Controls';
import { Field } from './Field';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { Touchable } from './Touchable';

export function RatingSheet({
  ticketId,
  visible,
  onClose,
  onRated,
}: {
  ticketId: string;
  visible: boolean;
  onClose: () => void;
  onRated: () => void;
}) {
  const { t, f, locale } = useI18n();
  const session = useSession();
  const [stars, setStars] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(new CommandKey(newIdempotencyKey)).current;

  const submit = async () => {
    if (stars < 1) return setError(t.rating.pickStars);
    setBusy(true);
    setError(null);
    const body = { stars, note: note.trim() || null };
    try {
      await session.api.rateVisit(ticketId, body, key.for(JSON.stringify(body)));
      key.reset();
      onRated();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CUSTOMER_VISIT_ALREADY_RATED') onRated();
      else setError(errorText(e, t, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onRequestClose={onClose}>
      <ScrollView contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <IconBadge name="star" size={48} tint={color.warningText} bg={color.warningSubtle} />
          <View style={styles.flex}>
            <AppText variant="cardTitle" accessibilityRole="header">
              {t.rating.title}
            </AppText>
            <AppText variant="small" tone="muted">
              {t.rating.hint}
            </AppText>
          </View>
        </View>
        <View style={styles.stars} accessibilityRole="radiogroup" accessibilityLabel={t.rating.title}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Touchable
              key={n}
              accessibilityRole="radio"
              accessibilityState={{ checked: stars === n }}
              accessibilityLabel={f(t.rating.star, { n })}
              onPress={() => setStars(n)}
              feedback="select"
              pressScale={0.9}
              style={[styles.star, n <= stars && styles.starOn]}
              hitSlop={4}
            >
              <Icon
                name="star"
                size={30}
                tint={n <= stars ? color.warning : color.textDisabled}
                {...(n <= stars ? { fill: color.warning } : {})}
              />
            </Touchable>
          ))}
        </View>
        <Field
          label={t.rating.noteLabel}
          placeholder={t.rating.notePlaceholder}
          value={note}
          onChangeText={setNote}
          maxLength={CUSTOMER_RATING_NOTE_MAX}
          multiline
        />
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Button
          label={t.rating.submit}
          loading={busy}
          loadingLabel={t.common.sending}
          onPress={() => void submit()}
        />
        <Button label={t.rating.skip} variant="ghost" size="md" onPress={onClose} />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheet: { padding: space[4], paddingTop: space[2], gap: space[3] },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  stars: { flexDirection: 'row', gap: space[2], justifyContent: 'center' },
  star: {
    minWidth: 52,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
  },
  starOn: { borderColor: color.warning, backgroundColor: color.warningSubtle },
});
