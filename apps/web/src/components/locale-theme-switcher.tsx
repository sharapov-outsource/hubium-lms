'use client';

import { Button } from '@hubium/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@hubium/ui/dropdown';
import { useTheme } from '@hubium/ui/theme';
import { Check, Languages, Monitor, Moon, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { setLocaleAction, setThemeAction } from '@/server/actions/preferences';

const LOCALES = [
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
] as const;

export function LocaleSwitcher() {
  const t = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const [, start] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('language')}>
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('language')}</DropdownMenuLabel>
        {LOCALES.map((l) => (
          <DropdownMenuItem
            key={l.code}
            lang={l.code}
            onSelect={() =>
              start(async () => {
                await setLocaleAction(l.code);
                router.refresh();
              })
            }
          >
            <span className="flex-1">{l.label}</span>
            {l.code === locale ? <Check /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThemeSwitcher() {
  const t = useTranslations('common');
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const items = [
    { value: 'light', label: t('themeLight'), icon: Sun },
    { value: 'dark', label: t('themeDark'), icon: Moon },
    { value: 'system', label: t('themeSystem'), icon: Monitor },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('theme')}>
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('theme')}</DropdownMenuLabel>
        {items.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => {
              setTheme(value);
              void setThemeAction(value);
            }}
          >
            <Icon />
            <span className="flex-1">{label}</span>
            {mounted && theme === value ? <Check /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LocaleThemeSwitcher() {
  return (
    <div className="flex items-center gap-1">
      <LocaleSwitcher />
      <ThemeSwitcher />
    </div>
  );
}

export { DropdownMenuSeparator };
