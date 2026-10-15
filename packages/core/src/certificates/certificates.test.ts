import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { toggleManualCompletion } from '../completion/completion.ts';
import { ConflictError, ForbiddenError } from '../errors.ts';
import {
  CERTIFICATES_REVIEW_JOB,
  certificatePdf,
  certificatePreview,
  deleteCertificate,
  issueCertificate,
  reviewCertificate,
  revokeCertificateIssue,
  saveCertificate,
  setCertificateBackground,
  setCertificateStatus,
  verifyCertificate,
} from './certificates.ts';
import { defaultFields } from './template.ts';

describe('certificates', () => {
  const t = useTestDb();

  it('is issued on completion, downloaded, checked by code and revoked', async () => {
    const f = await courseFixture(t.db, 'CERT1');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const student = await ctxFor(t.db, f.users.student1!);
    const other = await ctxFor(t.db, f.users.student2!);
    const a = await f.addActivity(
      'page',
      'Итог',
      { content: '<p>x</p>' },
      {
        completionMode: 'MANUAL',
      },
    );
    const { id } = await saveCertificate.run(teacher, {
      courseId: f.courseId,
      name: 'Сертификат слушателя',
      orientation: 'landscape',
      fields: defaultFields('landscape', 'ru'),
      onCompletion: true,
    });
    await expect(
      saveCertificate.run(teacher, {
        id,
        name: 'x',
        fields: [{ kind: 'name', x: 999, y: 10 }],
      }),
    ).rejects.toMatchObject({ fieldErrors: { fields: ['Check field 1'] } });
    await expect(
      saveCertificate.run(student, { courseId: f.courseId, name: 'x', fields: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setCertificateBackground.run(teacher, { id, data: new TextEncoder().encode('GIF89a') }),
    ).rejects.toMatchObject({
      fieldErrors: { background: [expect.stringMatching(/PNG or JPEG/)] },
    });

    // a learner who completed the course before it was switched on gets it from the review
    await toggleManualCompletion.run(other, { activityId: a.id, done: true });
    capturedJobs.length = 0;
    await setCertificateStatus.run(teacher, { id, status: 'ACTIVE' });
    expect(capturedJobs.map((j) => j.name)).toContain(CERTIFICATES_REVIEW_JOB);
    expect(await reviewCertificate(t.db, id)).toBe(1);
    expect(await reviewCertificate(t.db, id)).toBe(0);

    // completing the course issues it, once, with a notification
    await toggleManualCompletion.run(student, { activityId: a.id, done: true });
    await toggleManualCompletion.run(student, { activityId: a.id, done: false });
    await toggleManualCompletion.run(student, { activityId: a.id, done: true });
    const issues = await t.db.certificateIssue.findMany({
      where: { certificateId: id, userId: f.users.student1! },
    });
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(issue.data).toMatchObject({ name: 'Иван Петров', course: 'CERT1' });
    expect(
      await t.db.notification.count({
        where: { userId: f.users.student1!, type: 'certificate.issued' },
      }),
    ).toBe(1);

    // the PDF: its owner and the teacher, not another learner
    const pdf = await certificatePdf(student, issue.id);
    expect(pdf?.name).toBe('Сертификат слушателя Иван Петров.pdf');
    const doc = await PDFDocument.load(pdf!.data, { updateMetadata: false });
    expect(doc.getTitle()).toBe('Сертификат слушателя — Иван Петров');
    expect(await certificatePdf(teacher, issue.id)).not.toBeNull();
    expect(await certificatePdf(other, issue.id)).toBeNull();
    expect((await certificatePreview(teacher, id)).data.byteLength).toBeGreaterThan(1000);
    await expect(certificatePreview(student, id)).rejects.toBeInstanceOf(ForbiddenError);

    // anyone checks it by code, however it is typed
    expect(
      await verifyCertificate(t.db, issue.code.toLowerCase().replace(/-/g, ' ')),
    ).toMatchObject({
      name: 'Иван Петров',
      course: 'CERT1',
      certificate: 'Сертификат слушателя',
      revokedAt: null,
    });
    expect(await verifyCertificate(t.db, 'AAAA-BBBB-CCCC')).toBeNull();
    expect(await verifyCertificate(t.db, 'nonsense')).toBeNull();

    // issued: not deleted, not a draft
    await expect(deleteCertificate.run(teacher, { id })).rejects.toMatchObject({
      fieldErrors: { id: [expect.stringMatching(/archived/)] },
    });
    await expect(setCertificateStatus.run(teacher, { id, status: 'DRAFT' })).rejects.toMatchObject({
      fieldErrors: { status: [expect.stringMatching(/archived/)] },
    });

    // revoked: the check says so, no PDF, completion does not bring it back
    await revokeCertificateIssue.run(teacher, { issueId: issue.id, reason: 'Ошибка' });
    expect(await verifyCertificate(t.db, issue.code)).toMatchObject({ revokedReason: 'Ошибка' });
    expect(await certificatePdf(student, issue.id)).toBeNull();
    await toggleManualCompletion.run(student, { activityId: a.id, done: false });
    await toggleManualCompletion.run(student, { activityId: a.id, done: true });
    expect(
      (await t.db.certificateIssue.findUniqueOrThrow({ where: { id: issue.id } })).revokedAt,
    ).not.toBeNull();
    // by hand it stands again, with the same code
    await issueCertificate.run(teacher, { certificateId: id, userId: f.users.student1! });
    expect(await verifyCertificate(t.db, issue.code)).toMatchObject({ revokedAt: null });
    await expect(
      issueCertificate.run(teacher, { certificateId: id, userId: f.users.student1! }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('is issued by hand to learners only, and only while it is issued', async () => {
    const f = await courseFixture(t.db, 'CERT2');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { id } = await saveCertificate.run(teacher, {
      courseId: f.courseId,
      name: 'Участник',
      fields: defaultFields('portrait', 'en'),
      onCompletion: false,
    });
    await expect(
      issueCertificate.run(teacher, { certificateId: id, userId: f.users.student3! }),
    ).rejects.toMatchObject({ fieldErrors: { certificateId: [expect.any(String)] } });
    await setCertificateStatus.run(teacher, { id, status: 'ACTIVE' });
    await issueCertificate.run(teacher, { certificateId: id, userId: f.users.student3! });
    await expect(
      issueCertificate.run(teacher, { certificateId: id, userId: f.users.teacher! }),
    ).rejects.toMatchObject({ fieldErrors: { userId: [expect.any(String)] } });
    const issue = await t.db.certificateIssue.findFirstOrThrow({ where: { certificateId: id } });
    expect(issue.issuedById).toBe(teacher.perm.userId);
    // not by itself: completion does nothing for it
    expect(await reviewCertificate(t.db, id)).toBe(0);
    // archived: no more by hand either
    await setCertificateStatus.run(teacher, { id, status: 'ARCHIVED' });
    await expect(
      issueCertificate.run(teacher, { certificateId: id, userId: f.users.student1! }),
    ).rejects.toMatchObject({ fieldErrors: { certificateId: [expect.any(String)] } });
  });
});
