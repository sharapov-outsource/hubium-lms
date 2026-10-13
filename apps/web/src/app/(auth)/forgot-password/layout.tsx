import type { ReactNode } from 'react';
import { titled } from '@/server/page-title';

// The page is a client component, so its title is set here.
export const generateMetadata = titled('auth', 'forgotTitle');

export default function ForgotPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
