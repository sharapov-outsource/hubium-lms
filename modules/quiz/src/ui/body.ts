import type { PublicQuestion } from '../public.ts';

/** What the body of a question in the attempt player gets. */
export interface BodyProps {
  q: PublicQuestion;
  value: Record<string, unknown>;
  onChange: (v: unknown) => void;
  /** A checked answer: shown, not changed (immediate and interactive behaviours). */
  readOnly?: boolean;
}
