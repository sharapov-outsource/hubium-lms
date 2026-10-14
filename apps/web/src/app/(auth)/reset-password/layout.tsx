import type { ReactNode } from 'react';
import { titled } from '@/server/page-title';

// The form is a client component, so the title is set here.
export const generateMetadata = titled('auth', 'resetTitle');

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
