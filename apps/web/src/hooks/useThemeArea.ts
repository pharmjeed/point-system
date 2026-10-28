import { useEffect } from 'react';
import type { ThemeArea } from '@/lib/theme';
import { useUiStore } from '@/stores/ui';

/** Declares which theme preference applies to the current screen (driver: system, staff: light; DEC-19). */
export function useThemeArea(area: ThemeArea): void {
  const setThemeArea = useUiStore((s) => s.setThemeArea);
  useEffect(() => {
    setThemeArea(area);
  }, [area, setThemeArea]);
}
