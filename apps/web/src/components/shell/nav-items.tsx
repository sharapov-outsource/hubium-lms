import {
  BarChart3,
  BookOpen,
  CalendarDays,
  House,
  LayoutGrid,
  type LucideIcon,
  MessageSquare,
  Shield,
  Users,
} from 'lucide-react';

const icons = {
  home: House,
  courses: BookOpen,
  catalog: LayoutGrid,
  calendar: CalendarDays,
  messages: MessageSquare,
  admin: Shield,
  mentees: Users,
  reports: BarChart3,
} satisfies Record<string, LucideIcon>;

export type NavIconName = keyof typeof icons;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
  /** Also shown in the mobile bottom bar. */
  mobile?: boolean;
  /** A shorter label for the bottom bar. */
  mobileLabel?: string;
  /** Live unread counter shown as the badge. */
  liveBadge?: 'messages';
}

export function navIcon(name: NavIconName) {
  const Icon = icons[name];
  return <Icon aria-hidden />;
}
