/**
 * «بطاقة السيارة» (owner's option 2 for the large places, DEC-643): the car drawn big in its type and colour on a soft
 * tint of its own paint, the Saudi plate under it and one line «الصانع · الطراز · اللون · النوع». Used where the car is
 * the subject (the entry pass C-08, the C-05 preview); lists keep the compact row (`CarGlyph` beside `PlateBadge`).
 * The tint is the car's paint lightened (content, like the drawing, DEC-638), the plate and the line carry the
 * meaning, so the drawing stays decoration.
 */
import { carColors } from '@point/shared/customer';
import { StyleSheet, View } from 'react-native';
import { radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { CarGlyph } from './CarGlyph';
import { PlateBadge } from './PlateBadge';

export function CarCard({
  type,
  paint,
  plate,
  caption,
  width = 200,
  testID,
}: {
  type: string | null | undefined;
  /** the colour key of 02 §8.4, or free text */
  paint: string | null | undefined;
  /** the plate as written (`1234 ا ب ح`); none shows the car alone */
  plate?: string | null;
  caption?: string | null;
  width?: number;
  testID?: string;
}) {
  return (
    <View style={[styles.card, { backgroundColor: carColors(paint).tint }]} testID={testID}>
      <CarGlyph type={type} paint={paint} width={width} />
      {plate ? (
        <View>
          <PlateBadge plate={plate} size="lg" />
        </View>
      ) : null}
      {caption ? (
        <AppText tone="muted" center>
          {caption}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    gap: space[2],
    paddingTop: space[3],
    paddingBottom: space[4],
    paddingHorizontal: space[4],
    borderRadius: radius.xl,
  },
});
