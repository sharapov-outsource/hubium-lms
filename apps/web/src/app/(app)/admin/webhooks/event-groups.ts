import type { WebhookEvent } from '@hubium/core/webhooks/events';

/** Event types by topic, in the order the form lists them; every event of the core once. */
export const EVENT_GROUPS = {
  users: ['user.created', 'user.updated', 'user.suspended', 'user.unsuspended', 'user.deleted'],
  courses: ['course.created', 'course.updated', 'course.deleted'],
  learning: [
    'enrolment.created',
    'enrolment.deleted',
    'grade.updated',
    'activity.completed',
    'course.completed',
    'submission.submitted',
    'quiz.attempt.finished',
  ],
} as const satisfies Record<string, readonly WebhookEvent[]>;
