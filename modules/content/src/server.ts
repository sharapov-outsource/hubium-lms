import { extractText, sanitizeRichText, toEmbedUrl } from '@hubium/editor/server';
import { defineModule } from '@hubium/module-sdk';
import { z } from 'zod';

// Reference resource modules: page, url, label and file. They need no tables:
// everything lives in Activity.settings and the file area "content".

const html = z.string().max(500_000).default('').transform(sanitizeRichText);

export const page = defineModule({
  key: 'page',
  archetype: 'resource',
  icon: 'FileText',
  supports: { viewCompletion: true, backup: true },
  settings: {
    schema: z.object({ content: html }),
    defaults: () => ({ content: '' }),
  },
  extractText: (a) => extractText(a.settings.content),
});

export const url = defineModule({
  key: 'url',
  archetype: 'resource',
  icon: 'Link',
  supports: { viewCompletion: true, backup: true },
  settings: {
    schema: z.object({
      url: z
        .string()
        .trim()
        .url()
        .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links are allowed'),
      display: z.enum(['link', 'newtab', 'embed']).default('newtab'),
    }),
    defaults: () => ({ url: 'https://', display: 'newtab' as const }),
  },
  extractText: (a) => a.settings.url,
});

export function embedFor(link: string): string | null {
  return toEmbedUrl(link);
}

export const label = defineModule({
  key: 'label',
  archetype: 'inline',
  icon: 'Type',
  supports: { backup: true },
  settings: {
    schema: z.object({ content: html }),
    defaults: () => ({ content: '' }),
  },
  extractText: (a) => extractText(a.settings.content),
});

export const file = defineModule({
  key: 'file',
  archetype: 'resource',
  icon: 'Paperclip',
  supports: { viewCompletion: true, backup: true },
  settings: {
    schema: z.object({ display: z.enum(['list', 'download']).default('list') }),
    defaults: () => ({ display: 'list' as const }),
  },
  files: {
    // Anyone who can open the activity may download its files.
    content: { canRead: async () => true },
  },
});

export const contentModules = [page, url, label, file];
