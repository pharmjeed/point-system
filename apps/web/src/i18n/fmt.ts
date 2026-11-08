/**
 * Fills `{name}` placeholders in a dictionary string. Numbers are written with Western digits (DEC-17);
 * unknown placeholders are left untouched so a missing value is visible instead of silently dropped.
 */
export function fmt(template: string, vars: Record<string, string | number | null | undefined> = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return whole;
    return typeof value === 'number' ? String(value) : value;
  });
}
