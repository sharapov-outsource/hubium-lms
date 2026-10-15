'use client';

import { Button } from '@hubium/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@hubium/ui/dropdown';
import { useTheme } from '@hubium/ui/theme';
import { Check, Languages, Monitor, Moon, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { setLocaleAction, setThemeAction } from '@/server/actions/preferences';

/** An enabled language: its code and its own name (from the language pack). */
export interface LanguageOption {
  code: string;
  name: string;
}

/** Hidden when the site offers a single language. */
export function LocaleSwitcher({ languages }: { languages: LanguageOption[] }) {
  const t = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const [, start] = useTransition();
  if (languages.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('language')}>
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('language')}</DropdownMenuLabel>
        {languages.map((l) => (
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
            <span className="flex-1">{l.name}</span>
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

export function LocaleThemeSwitcher({ languages }: { languages: LanguageOption[] }) {
  return (
    <div className="flex items-center gap-1">
      <LocaleSwitcher languages={languages} />
      <ThemeSwitcher />
    </div>
  );
}
