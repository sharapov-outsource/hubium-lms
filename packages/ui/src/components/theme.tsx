'use client';

import { ThemeProvider as NextThemes } from 'next-themes';
import type { ReactNode } from 'react';
import { Toaster as Sonner } from 'sonner';

export function ThemeProvider({
  children,
  defaultTheme = 'system',
}: {
  children: ReactNode;
  defaultTheme?: string;
}) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme={defaultTheme}
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemes>
  );
}

export function Toaster() {
  return <Sonner position="bottom-right" richColors closeButton />;
}

export { useTheme } from 'next-themes';
export { toast } from 'sonner';
