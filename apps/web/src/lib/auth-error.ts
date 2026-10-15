'use client';

import { useTranslations } from 'next-intl';

// A Better Auth refusal shown in a form: its code's message in the language packs
// (errors.authCodes, as authErrorText does on the server), else the text it came with —
// a password policy refusal is already in the person's language — else the form's own.

export function useAuthErrorText() {
  const t = useTranslations('errors.authCodes');
  return (error: { code?: string; message?: string } | null | undefined, fallback: string) => {
    const code = error?.code;
    if (code && t.has(code as never)) return t(code as never);
    return error?.message || fallback;
  };
}
