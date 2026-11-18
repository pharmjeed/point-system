import type { ar } from './ar';

type Widen<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Widen<U>[]
    : { readonly [K in keyof T]: Widen<T[K]> };

/** The shape every language must provide: the Arabic dictionary's keys, any text. */
export type Dictionary = Widen<typeof ar>;

export type AppLocale = 'ar' | 'en';
