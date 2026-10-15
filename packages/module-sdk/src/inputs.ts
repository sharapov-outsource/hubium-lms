import { z } from 'zod';

// Inputs that module actions share.

/** A file sent with an action (a submission, an attachment, an entry's picture). */
export const FileInput = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().default('application/octet-stream'),
  data: z.instanceof(Buffer),
});
