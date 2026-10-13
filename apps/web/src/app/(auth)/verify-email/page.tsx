import { Alert, Button } from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('auth', 'verifyEmailTitle');

// Better Auth redirects here (callbackURL) after verification; errors come as ?error=.
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [t, sp] = await Promise.all([getTranslations('auth'), searchParams]);
  return (
    <div className="grid gap-4">
      {sp.error ? (
        <Alert variant="destructive">{t('resetInvalid')}</Alert>
      ) : (
        <Alert variant="success">{t('verifiedTitle')}</Alert>
      )}
      <Button asChild variant="secondary">
        <Link href="/login">{t('backToSignIn')}</Link>
      </Button>
    </div>
  );
}
