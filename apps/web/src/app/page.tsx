import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/session';

export default async function Home() {
  redirect((await getCurrentUser()) ? '/dashboard' : '/login');
}
