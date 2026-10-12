'use client';

import { createContext, useContext } from 'react';

/** Field errors of the surrounding form, keyed by input name (e.g. "settings.url"). */
export const FieldErrorsContext = createContext<Record<string, string[]> | undefined>(undefined);

export function useFieldErrors(name: string): string[] | undefined {
  return useContext(FieldErrorsContext)?.[name];
}
