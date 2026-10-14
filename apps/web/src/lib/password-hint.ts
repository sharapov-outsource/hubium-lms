// The password policy as a one-line hint under password fields. Works with both
// useTranslations('auth') and getTranslations('auth').

export interface PasswordRules {
  minLength: number;
  requireDigit: boolean;
  requireLower: boolean;
  requireUpper: boolean;
  requireSymbol: boolean;
  history: number;
}

type RuleKey =
  | 'passwordRules.minLength'
  | 'passwordRules.needs'
  | 'passwordRules.digit'
  | 'passwordRules.lower'
  | 'passwordRules.upper'
  | 'passwordRules.symbol'
  | 'passwordRules.history';

export function passwordHint(
  t: (key: RuleKey, values?: Record<string, string | number>) => string,
  r: PasswordRules,
): string {
  const needs = [
    r.requireDigit && t('passwordRules.digit'),
    r.requireLower && t('passwordRules.lower'),
    r.requireUpper && t('passwordRules.upper'),
    r.requireSymbol && t('passwordRules.symbol'),
  ].filter((x): x is string => !!x);
  return [
    t('passwordRules.minLength', { n: r.minLength }),
    needs.length ? t('passwordRules.needs', { list: needs.join(', ') }) : '',
    r.history ? t('passwordRules.history', { n: r.history }) : '',
  ]
    .filter(Boolean)
    .join('; ');
}
