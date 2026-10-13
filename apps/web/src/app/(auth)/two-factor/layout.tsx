import type { ReactNode } from 'react';
import { titled } from '@/server/page-title';

// The page is a client component, so its title is set here.
export const generateMetadata = titled('auth', 'twoFactorTitle');

export default function TwoFactorLayout({ children }: { children: ReactNode }) {
  return children;
}
