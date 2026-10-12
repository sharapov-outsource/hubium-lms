import { GraduationCap } from 'lucide-react';
import Link from 'next/link';

export function SiteLogo({
  name,
  hasLogo,
  href = '/',
}: {
  name: string;
  hasLogo: boolean;
  href?: string;
}) {
  return (
    <Link href={href} className="flex items-center gap-2 font-semibold tracking-tight">
      {hasLogo ? (
        // biome-ignore lint/performance/noImgElement: served by our branding route
        <img src="/branding/logo" alt={name} className="h-8 max-w-40 object-contain" />
      ) : (
        <>
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <GraduationCap className="size-5" aria-hidden />
          </span>
          <span>{name}</span>
        </>
      )}
    </Link>
  );
}
