import { CertificateNew } from '@/components/certificates/certificate-views';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('certificates', 'new');

export default async function NewCertificatePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  return <CertificateNew courseId={(await params).courseId} />;
}
