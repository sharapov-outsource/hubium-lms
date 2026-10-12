'use client';

import { ThemeProvider as NextThemes, useTheme } from 'next-themes';
import type { ReactNode } from 'react';
import { Toaster as Sonner } from 'sonner';

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  nonce,
}: {
  children: ReactNode;
  defaultTheme?: string;
  /** CSP nonce for the inline theme script. */
  nonce?: string;
}) {
  return (
    <NextThemes
      nonce={nonce}
      attribute="class"
      defaultTheme={defaultTheme}
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemes>
  );
}

/** Toasts styled with our tokens (sonner's richColors fail WCAG contrast). */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      position="bottom-right"
      closeButton
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      toastOptions={{
        classNames: {
          toast: '!bg-card !text-card-foreground !border-border',
          success: '!bg-success-soft !text-success',
          warning: '!bg-warning-soft !text-warning',
          error: '!text-destructive',
          description: '!text-muted-foreground',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
export { useTheme };
