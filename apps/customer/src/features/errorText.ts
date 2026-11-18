/**
 * One sentence for any failure (03 §6: what happened + what to do): dictionary text for known codes, else the
 * server's own text in the app's language, else the generic one. No technical terms, no status codes.
 */
import { ApiError } from '../api/errors';
import { NetworkError } from '../api/transport';
import type { AppLocale, Dictionary } from '../i18n';

export function errorText(e: unknown, dict: Dictionary, locale: AppLocale): string {
  if (e instanceof NetworkError) return dict.common.networkError;
  if (e instanceof ApiError) {
    const known = (dict.errors as Readonly<Record<string, string>>)[e.code];
    if (known) return known;
    const server = locale === 'ar' ? e.messageAr : e.message;
    return server || dict.common.unexpectedError;
  }
  return dict.common.unexpectedError;
}
