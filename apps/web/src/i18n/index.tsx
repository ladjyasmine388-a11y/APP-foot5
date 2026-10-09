import { DEFAULT_LOCALE, type Locale } from '@footfive/shared';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../lib/api';
import { detectLocale, directionOf, formatDate, formatDateTime, formatMoney, formatNumber, formatTime, interpolate, isLocale } from './format';
import { errorMessages } from './messages/errors';
import { type MessageKey, messages } from './messages/index';

export type { MessageKey } from './messages/index';

const STORAGE_KEY = 'ff.locale';

interface I18n {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  /** Traduction d'une clé qui peut ne pas exister (valeur saisie librement, ex. équipement) : null si inconnue. */
  tMaybe: (key: string) => string | null;
  /** Message d'une erreur de l'API (ou réseau), dans la langue courante. */
  tError: (error: unknown) => string;
  money: (amountMinor: number) => string;
  date: (iso: string | Date, style?: 'short' | 'long') => string;
  time: (iso: string | Date) => string;
  dateTime: (iso: string | Date) => string;
  number: (value: number, maxFractionDigits?: number) => string;
}

const I18nContext = createContext<I18n | null>(null);

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* stockage indisponible (navigation privée) */
  }
  return detectLocale(typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]);
}

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initial ?? initialLocale);

  // Langue et sens de lecture portés par <html> : les propriétés CSS logiques et les lecteurs d'écran s'y adaptent.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = directionOf(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* préférence non mémorisée, sans conséquence */
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({
      locale,
      dir: directionOf(locale),
      setLocale,
      t: (key, params) => interpolate(messages[key][locale] ?? messages[key][DEFAULT_LOCALE], params),
      tMaybe: (key) => (Object.hasOwn(messages, key) ? messages[key as MessageKey][locale] : null),
      tError: (error) => {
        const code = error instanceof ApiError ? error.code : 'UNKNOWN';
        return (errorMessages[code] ?? errorMessages.UNKNOWN)[locale];
      },
      money: (amount) => formatMoney(amount, locale),
      date: (iso, style) => formatDate(iso, locale, style),
      time: (iso) => formatTime(iso, locale),
      dateTime: (iso) => formatDateTime(iso, locale),
      number: (n, digits) => formatNumber(n, locale, digits),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n doit être utilisé dans <I18nProvider>');
  return ctx;
}
