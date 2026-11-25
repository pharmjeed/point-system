import { describe, expect, it } from 'vitest';
import * as shared from '../../../../packages/shared/src/vehicle-art';
import * as local from './vehicleArt';

describe('vehicle art (DEC-642)', () => {
  it('draws the same cars and paints as the customer app', () => {
    expect(local.CAR_VIEWBOX).toBe(shared.CAR_VIEWBOX);
    expect(local.CAR_ART).toEqual(shared.CAR_ART);
    expect(local.VEHICLE_COLOR_PAINT).toEqual(shared.VEHICLE_COLOR_PAINT);
  });

  it('picks the shape and the paint, with neutral fallbacks', () => {
    expect(local.carShape('suv')).toBe('suv');
    expect(local.carShape('other')).toBe('sedan');
    expect(local.carShape(null)).toBe('sedan');
    expect(local.carPaint('white')).toBe('#FFFFFF');
    expect(local.carPaint('لون خاص')).toBeNull();
    expect(local.paintIsDark('#141414')).toBe(true);
    expect(local.paintIsDark('#FFFFFF')).toBe(false);
  });
});
