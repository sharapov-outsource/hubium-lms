'use client';

import { createContext, type ReactNode, useContext } from 'react';

/** Texts the design system shows on its own (set once at the app root, translated). */
export interface UiText {
  chooseFile: string;
  chooseFiles: string;
  noFile: string;
  noFiles: string;
  /** Placeholder of the search box in long lists. */
  search: string;
  nothingFound: string;
  /** The name of a dialog's close button. */
  close: string;
}

const defaults: UiText = {
  chooseFile: 'Choose file',
  chooseFiles: 'Choose files',
  noFile: 'No file chosen',
  noFiles: 'No files chosen',
  search: 'Search…',
  nothingFound: 'Nothing found',
  close: 'Close',
};

const UiTextContext = createContext<UiText>(defaults);

export function UiTextProvider({ value, children }: { value: UiText; children: ReactNode }) {
  return <UiTextContext.Provider value={value}>{children}</UiTextContext.Provider>;
}

export function useUiText(): UiText {
  return useContext(UiTextContext);
}
