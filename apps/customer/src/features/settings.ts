/**
 * C-19 الإعدادات (V2-017, docs/v2/01 R6): language (Arabic / English, kept on the device and sent to the account so
 * WhatsApp and push follow it), notifications (V2-016, ./push.ts), «تواصل معنا» from the
 * configuration, «الشروط والأحكام» (C-24, in the app) and the privacy page the API names
 * (`consents.privacy.document_url`), the app version, sign out and «حذف الحساب» (C-20). Pure.
 */
import type { CustomerMe } from '@point/shared/customer';
import type { AppConfig } from '../configModel';
import type { AppLocale, Dictionary } from '../i18n';

export interface LinkItem {
  key: 'whatsapp' | 'email' | 'privacy';
  label: string;
  url: string;
}

export interface SettingsView {
  languages: ReadonlyArray<{ value: AppLocale; label: string }>;
  support: LinkItem[];
  documents: LinkItem[];
  version: string;
}

export function settingsView(
  me: CustomerMe | null,
  config: Pick<AppConfig, 'support' | 'version'>,
  dict: Dictionary,
): SettingsView {
  const support: LinkItem[] = [];
  if (config.support.whatsapp)
    support.push({
      key: 'whatsapp',
      label: dict.settings.supportWhatsapp,
      url: `https://wa.me/${config.support.whatsapp}`,
    });
  if (config.support.email)
    support.push({
      key: 'email',
      label: dict.settings.supportEmail,
      url: `mailto:${config.support.email}`,
    });
  // the terms are read in the app (C-24, DEC-614); the privacy policy stays the page the API names
  const documents: LinkItem[] = [];
  const privacy = me?.consents.privacy.document_url;
  if (privacy) documents.push({ key: 'privacy', label: dict.settings.privacy, url: privacy });
  return {
    // each language is named in itself, so it can be found whatever the current language is
    languages: [
      { value: 'ar', label: dict.settings.languageNames.ar },
      { value: 'en', label: dict.settings.languageNames.en },
    ],
    support,
    documents,
    version: config.version,
  };
}

/** A stored language preference (secure storage holds a string): anything else means «follow the device». */
export const parseStoredLocale = (v: string | null | undefined): AppLocale | null =>
  v === 'ar' || v === 'en' ? v : null;
