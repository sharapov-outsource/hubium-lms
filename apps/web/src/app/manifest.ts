import { getAllSettings } from '@hubium/core';
import type { MetadataRoute } from 'next';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const s = await getAllSettings(db);
  return {
    name: s['site.name'],
    short_name: s['site.name'].slice(0, 12),
    description: 'Hubium LMS',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: s['branding.accent'],
    lang: s['site.defaultLocale'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
