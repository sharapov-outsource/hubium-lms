# REST API v1

Hubium exposes a REST API for integrations (HR systems, reporting, mobile clients, scripts).

- Base URL: `https://<your-site>/api/v1`
- Interactive docs: `/api/v1/docs` (Scalar), machine-readable spec: `/api/v1/openapi.json` (OpenAPI 3.1)
- Format: JSON in and out, UTF-8, timestamps in ISO 8601 (UTC)

## Authentication

Create a personal access token in **Settings → API tokens**. The token is shown once; only its SHA-256 hash is stored.

```bash
curl -H "Authorization: Bearer hub_XXXXXXXX…" https://lms.example.org/api/v1/me
```

A token acts as its user and never exceeds the user's permissions. Scopes narrow it further:

| Scope | Allows |
|---|---|
| `read` | `GET` endpoints |
| `write` | `POST`/`PUT`/`PATCH`/`DELETE` endpoints |

Tokens expire after 30/90/365 days or never; revoke them in the same settings page or with `DELETE /api/v1/tokens/{id}`. Administrators control who may create tokens with the `webservice:createtoken` capability.

## Rate limits

Each token may make `API_RATE_LIMIT_PER_MIN` requests per minute (120 by default). Responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`; over the limit the API answers `429` with `Retry-After`.

## Errors

```json
{ "code": "VALIDATION", "message": "Validation failed", "fieldErrors": { "to": ["Invalid range"] } }
```

| HTTP | `code` |
|---|---|
| 400 | `VALIDATION`, `BAD_REQUEST` |
| 401 | `UNAUTHENTICATED` (missing, unknown, revoked or expired token) |
| 403 | `FORBIDDEN` (scope or capability) |
| 404 | `NOT_FOUND` (also for things you may not see) |
| 409 | `CONFLICT` |
| 429 | `RATE_LIMITED` |

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/me` | the token owner |
| GET, POST | `/users` | search and create users (administrators) |
| GET | `/categories` | course categories |
| GET, POST | `/courses` | your courses; create a course |
| GET | `/courses/{id}` | course details |
| GET | `/courses/{id}/contents` | sections and the activities you can see |
| GET, POST | `/courses/{id}/enrolments` | participants; manual enrolment |
| GET | `/courses/{id}/groups` | groups |
| GET | `/courses/{id}/grades` | your grades, `?userId=` for one student, `?all=1` for the grader report |
| GET | `/activities/{id}` | an activity you can open |
| POST | `/activities/{id}/actions/{name}` | run a module action, e.g. assignment `saveSubmission`, forum `reply` |
| GET | `/calendar/events?from&to` | events in a range (≤ 400 days) |
| GET | `/conversations` | your conversations |
| GET, POST | `/conversations/{id}/messages` | read and send messages |
| GET | `/notifications` | notifications, `?unread=1` |
| POST | `/notifications/read` | mark read (all when `ids` is omitted) |
| GET | `/tokens`, DELETE `/tokens/{id}` | your tokens |
| GET | `/webhook-events` | event types a webhook can subscribe to |
| GET, POST | `/webhooks` | webhooks; create one (the response carries its secret once) |
| GET, PATCH, DELETE | `/webhooks/{id}` | one webhook |
| POST | `/webhooks/{id}/rotate-secret`, `/webhooks/{id}/ping` | new signing secret; send a test event |
| GET | `/webhooks/{id}/deliveries` | delivery log, newest first |
| POST | `/webhooks/deliveries/{id}/redeliver` | send a past delivery again |

Webhook endpoints are for administrators (`site:config`) and need a token with the `write` scope to change anything.

## Examples

Enrol two users as students:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"userIds":["0199…","0199…"],"roleId":"<student role id>"}' \
  https://lms.example.org/api/v1/courses/$COURSE/enrolments
```

Submit an assignment on behalf of the token owner:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"<p>My answer</p>","submit":true}' \
  https://lms.example.org/api/v1/activities/$ASSIGN/actions/saveSubmission
```

A typed client can be generated from the spec, e.g. `npx openapi-typescript https://lms.example.org/api/v1/openapi.json -o hubium.d.ts`.

## Webhooks

Instead of polling, another system can receive events as they happen. An administrator adds a webhook in **Administration → Webhooks** (or with `POST /webhooks`): a name, an HTTPS address and the event types to send. Hubium LMS then POSTs every matching event to that address.

### Events

| Type | When | `data` |
|---|---|---|
| `user.created`, `user.updated`, `user.suspended`, `user.unsuspended` | an account is created, changed, blocked or unblocked | `user` |
| `user.deleted` | an account is deleted (personal data is erased) | `user` with `id` only |
| `course.created`, `course.updated`, `course.deleted` | a course is created, changed or moved to the recycle bin | `course` |
| `enrolment.created`, `enrolment.deleted` | someone is enrolled in a course (any method) or unenrolled | `user`, `course`, `method` |
| `grade.updated` | a grade changes: teacher, quiz, assignment, override; course totals included | `user`, `course`, `activity`?, `gradeItem`, `grade` |
| `activity.completed` | an activity becomes complete for someone | `user`, `course`, `activity`, `state` |
| `course.completed` | someone completes every tracked activity of a course | `user`, `course`, `completedAt` |
| `submission.submitted` | an assignment is submitted for grading | `user`, `course`, `activity` |
| `quiz.attempt.finished` | a quiz attempt is finished, by the student or when time runs out | `user`, `course`, `activity`, `attemptId`, `sumGrades` |
| `ping` | the administrator sends a test | `webhook` |

`user` is `{ id, username, email, firstName, lastName, name, status }` (`email` is null for accounts without one); `course` is `{ id, shortName, fullName, idNumber, categoryId, visible, startDate, endDate }`; `activity` is `{ id, name, module, courseId }`; `gradeItem` is `{ id, name, kind, gradeMax }`. Every event also has `actorId`, the user who caused it (null for automatic changes). Since events carry names and email addresses, mention the receiving system in your privacy policy.

### Request

```http
POST /hubium-events HTTP/1.1
Content-Type: application/json
User-Agent: HubiumLMS-Webhooks/1
X-Hubium-Event: enrolment.created
X-Hubium-Delivery: 01a13a6e-9f0c-7b52-8d1e-3c2f6a1b0e47
X-Hubium-Signature: t=1792141200,v1=5d41402abc4b2a76b9719d911017c592…

{"id":"01a13a6e-…","type":"enrolment.created","occurredAt":"2026-10-13T11:40:00.000Z",
 "data":{"user":{"id":"…","username":"ivanova","email":"ivanova@example.org",…},
         "course":{"id":"…","shortName":"DEMO-PY",…},"method":"manual","actorId":"…"}}
```

Answer with any 2xx status within 10 seconds; do slow work after answering. The `id` (also in `X-Hubium-Delivery`) is the delivery's: use it to ignore duplicates. Events are not guaranteed to arrive in order; use `occurredAt`.

### Verifying the signature

`X-Hubium-Signature` is `t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the webhook's secret>`. Check it against the raw body before parsing, and refuse old timestamps:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

The secret (`whsec_…`) is shown once, when the webhook is created or its secret is replaced.

### Retries and the delivery log

- Network errors, timeouts and 408, 429 or 5xx answers are retried: the pause starts at 5–10 minutes and doubles, up to 6 hours, for at most 9 attempts over about a day. Other 4xx answers and redirects are not retried; redirects are never followed.
- After 50 failed deliveries in a row the webhook is switched off; switching it back on resets the count.
- Every delivery, with the answer's status and the start of its body, stays in the log for 30 days; failed ones can be sent again.
- Internal addresses (localhost, private and link-local networks) are refused unless the host is listed in `SSRF_ALLOW_HOSTS`.

## Versioning

Breaking changes go to `/api/v2`. Endpoints scheduled for removal answer with a `Deprecation` header at least six months in advance; additive changes (new fields, new endpoints) happen within v1.
