import {
  BookA,
  BookOpen,
  Box,
  ClipboardCheck,
  ClipboardList,
  Database,
  FileText,
  Link,
  ListChecks,
  type LucideIcon,
  MessagesSquare,
  NotebookPen,
  Package,
  Paperclip,
  PlaySquare,
  Plug,
  Presentation,
  Puzzle,
  Signpost,
  Type,
  Users,
  Vote,
} from 'lucide-react';

/** The icons modules name (ModuleDef.icon); an unknown name gets a box. */
const icons: Record<string, LucideIcon> = {
  BookA,
  BookOpen,
  ClipboardCheck,
  ClipboardList,
  Database,
  FileText,
  Link,
  ListChecks,
  MessagesSquare,
  NotebookPen,
  Package,
  Paperclip,
  PlaySquare,
  Plug,
  Presentation,
  Puzzle,
  Signpost,
  Type,
  Users,
  Vote,
};

const tones: Record<string, string> = {
  resource: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  activity: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  inline: 'bg-muted text-muted-foreground',
};

export function ModuleIcon({
  icon,
  archetype = 'resource',
  size = 36,
}: {
  icon: string;
  archetype?: string;
  size?: number;
}) {
  const Icon = icons[icon] ?? Box;
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-lg ${tones[archetype] ?? tones.resource}`}
      style={{ width: size, height: size }}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}
