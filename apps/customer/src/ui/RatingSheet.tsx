/**
 * C-13 قيّم الخدمة (V2-015, DEC-518): a bottom sheet after the delivery — 1–5 stars (each a 44-point target with its
 * number read out, never colour alone) and an optional note; «تخطَّ» closes it. One Idempotency-Key per sending.
 */
import { CUSTOMER_RATING_NOTE_MAX } from '@point/shared/customer';
import { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { ApiError } from '../api/errors';
import { CommandKey } from '../features/commandKey';
import { errorText } from '../features/errorText';
import { useI18n } from '../i18n/I18nProvider';
import { newIdempotencyKey } from '../session/secureStore';
import { useSession } from '../session/SessionProvider';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { Button } from './Button';
import { Banner } from './Controls';
import { Field } from './Field';

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
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <AppText variant="cardTitle" accessibilityRole="header">
            {t.rating.title}
          </AppText>
          <AppText tone="muted">{t.rating.hint}</AppText>
          <View style={styles.stars} accessibilityRole="radiogroup" accessibilityLabel={t.rating.title}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Pressable
                key={n}
                accessibilityRole="radio"
                accessibilityState={{ checked: stars === n }}
                accessibilityLabel={f(t.rating.star, { n })}
                onPress={() => setStars(n)}
                style={[styles.star, n <= stars && styles.starOn]}
                hitSlop={4}
              >
                <AppText style={[styles.starText, n <= stars && styles.starTextOn]}>
                  {n <= stars ? '★' : '☆'}
                </AppText>
              </Pressable>
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
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: color.bg },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space[4],
    gap: space[3],
  },
  stars: { flexDirection: 'row', gap: space[2], justifyContent: 'center' },
  star: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
  },
  starOn: { borderColor: color.primary, backgroundColor: color.primarySubtle },
  starText: { fontFamily: font.regular, ...fontSize['2xl'], color: color.textMuted },
  starTextOn: { color: color.primaryText },
});
