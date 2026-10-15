import { CertificateList } from '@/components/certificates/certificate-views';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('certificates', 'title');

export default async function CourseCertificatesPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  return <CertificateList courseId={(await params).courseId} />;
}
