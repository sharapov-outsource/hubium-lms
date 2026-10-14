import { getAllSettings, passwordPolicy } from '@hubium/core';
import { db } from '@/server/db';
import { ResetPasswordView } from './reset-form';

export default async function ResetPasswordPage() {
  return <ResetPasswordView rules={passwordPolicy(await getAllSettings(db))} />;
}
