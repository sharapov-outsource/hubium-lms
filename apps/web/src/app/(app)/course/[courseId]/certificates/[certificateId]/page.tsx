import { CertificateView } from '@/components/certificates/certificate-views';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('certificates', 'title');

export default async function CertificatePage({
  params,
}: {
  params: Promise<{ courseId: string; certificateId: string }>;
}) {
  const { courseId, certificateId } = await params;
  return <CertificateView courseId={courseId} certificateId={certificateId} />;
}
