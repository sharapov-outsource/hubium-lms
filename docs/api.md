# REST API v1

Hubium LMS exposes a REST API for integrations (HR systems, reporting, mobile clients, scripts).

- Base URL: `https://<your-site>/api/v1`
- Interactive reference: `/api/v1/docs`. The page is served by the site itself (no CDN, works without internet access) and lists every endpoint, schema and module action.
- Machine-readable spec: `/api/v1/openapi.json` (OpenAPI 3.1)
- Format: JSON in and out, UTF-8, timestamps in ISO 8601 (UTC)

## Authentication

Create a personal access token in **Settings → API tokens**. The token is shown once; only its SHA-256 hash is stored.

```bash
curl -H "Authorization: Bearer hub_XXXXXXXX…" https://lms.example.org/api/v1/me
```

Every endpoint except the spec and the reference page needs a token. A token acts as its user and never exceeds the user's permissions. Scopes narrow it further:

| Scope | Allows |
|---|---|
| `read` | `GET` endpoints |
| `write` | `POST`/`PUT`/`PATCH`/`DELETE` endpoints |

Tokens expire after 30/90/365 days or never; revoke them in the same settings page or with `DELETE /api/v1/tokens/{id}`. Administrators control who may create tokens with the `webservice:createtoken` capability. Taking that capability away also stops existing tokens.

## Rate limits

Each token may make `API_RATE_LIMIT_PER_MIN` requests per minute (120 by default), counted by each web instance. Responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`; over the limit the API answers `429` with `Retry-After`. Upload chunks count as requests.

## Errors

```json
{ "code": "VALIDATION", "message": "Validation failed", "fieldErrors": { "to": ["Invalid range"] } }
```

| HTTP | `code` |
|---|---|
| 400 | `VALIDATION` (with `fieldErrors`), `BAD_REQUEST` (malformed JSON; a module refusing an action, e.g. "Already submitted") |
| 401 | `UNAUTHENTICATED` (missing, unknown, revoked or expired token) |
| 403 | `FORBIDDEN` (scope or capability) |
| 404 | `NOT_FOUND` (also for things you may not see) |
| 409 | `CONFLICT` (the value is already taken) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` (a body that is neither JSON nor a form where one is expected) |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` (details stay in the server log) |

## Lists

Lists that can grow take `page` (from 1) and `pageSize` and answer `{ "items": […], "total": 123, "page": 1 }`: `/users`, `/catalog`, `/courses/{id}/enrolments`, `/webhooks/{id}/deliveries`. Shorter lists answer `{ "items": […] }`.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/me` | the token owner |
| GET | `/me/mentees` | learners you follow as a parent or mentor |
| GET, POST | `/users` | search and create users (administrators) |
| GET | `/users/{id}/overview` | a learner's courses, progress, course totals and deadlines |
| GET | `/categories` | course categories |
| GET | `/catalog?q&categoryId` | search the course catalog (word forms, prefixes, typos), best match first |
| GET, POST | `/courses` | your courses; create a course |
| GET | `/courses/{id}` | course details |
| GET | `/courses/{id}/contents` | sections and the activities you can see |
| GET, POST | `/courses/{id}/enrolments` | participants; manual enrolment |
| GET | `/courses/{id}/groups` | groups |
| GET | `/courses/{id}/groupings` | groupings and their groups |
| GET | `/courses/{id}/grades` | your grades, `?userId=` for one student, `?all=1` for the grader report |
| GET | `/activities/{id}` | an activity you can open |
| POST | `/activities/{id}/actions/{name}` | run a module action, e.g. assignment `saveSubmission`, forum `reply` |
| POST | `/uploads` | start a resumable upload of a large file |
| GET, PATCH | `/uploads/{id}` | where an upload stands; append the next chunk |
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

### Users

Users carry their custom profile fields (**Administration → Profile fields**) as `customFields`, an object keyed by each field's short name: text, a `YYYY-MM-DD` date, a menu option or `true`/`false`. `GET /me` and `GET /users` return them, and `POST /users` accepts them; values are validated by field type.

`POST /users` needs a username, an email or both: pupils without an email sign in with their username, and the API shows their `email` as `null`. It also takes `locale`, `timezone` and `mustChangePassword`.

### Mentors and parents

When **Administration → Settings → General → Mentors and parents** is on, `GET /me/mentees` lists the learners linked to the token owner (`kind` is `PARENT` or `MENTOR`, `lastAccessAt` the learner's last visit). For each of them `GET /users/{id}/overview` returns the courses they study with progress and the course total (when the learner may see it), and their upcoming submissions and quizzes; `GET /courses/{id}/grades?userId=` returns their grades as the learner sees them. With the setting off, the list is empty and the other two answer 403.

### Courses

Courses carry `idNumber`, the key of the course in your other systems (unique; set it with `POST /courses`), plus `categoryId`, `startDate` and `endDate`. `/catalog` returns only visible courses, with the category name and the enabled ways to join (`self`, `guest`, …).

### Grades

`GET /courses/{id}/grades` describes the gradebook along with the grades:

- `categories`: the category tree (`parentId` null for the course category), each with its aggregation and its weight in the parent.
- `items`: grade items with `kind` (`MODULE`, `MANUAL`, `CATEGORY`, `COURSE`), `gradeType` and the range. For a scale item (`gradeType: "SCALE"`) `scale` lists the scale's grades, and `finalGrade` is the 1-based position in that list.
- `grades`: one row per user and item that has a grade, with `overridden` and `excluded` flags.
- `categoryTotals` (only with `?all=1`): every category's total per student in percent, as the grader report shows it. The course total is also the grade of the `COURSE` item.

A learner's own report leaves out hidden items and categories.

## Module data

`GET /activities/{id}/queries/{name}` reads what the module's pages show, with the same rules: the activity must be open to you, and each query applies its module's own visibility rules. A read-only token is enough. Parameters are query-string values; the spec documents every query's parameters and result as `Query.<module>.<query>`. Dates are ISO strings.

| Module | Query | Parameters | Returns |
|---|---|---|---|
| forum | `discussions` | `page`, `pageSize` (≤ 50) | discussions you may see (pinned first), unread counts, whether you may start one, your subscription, the groups you may post to |
| forum | `discussion` | `discussionId` | the discussion and its posts as a flat list (`parentId` gives the tree), attachments, what you may edit or delete; it does not mark posts read (`markRead` does) |
| quiz | `overview` | — | the window, attempts used and left, the attempt in progress, your grade, your attempts and which of them you may review |
| quiz | `attempt` | `attemptId` | the questions of your attempt in progress, without correct answers; answer with `save` and `finish`. In the immediate and interactive behaviours each question also carries its state, whether `check` may be used, the tries left and the feedback of the last check |
| quiz | `review` | `attemptId` | a finished attempt: answers, verdicts and marks, correct answers and feedback as far as the quiz's review settings allow; for teachers the steps of each answer |
| assign | `status` | — | your dates (with your own or your group's), your team and who has submitted, whether you may submit or withdraw now, your submission (or your team's) and files, how late it is and the penalty, the latest grade with feedback and the penalty taken |

Private forum replies show only to their author, the recipient and moderators; in a Q&A forum other answers show once you have answered; separate groups keep their discussions apart. A discussion, attempt or submission that is not yours to see answers `404`. `attempt` answers `409` once the attempt is finished, and `review` answers `409` while it is still in progress.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://lms.example.org/api/v1/activities/$QUIZ/queries/review?attemptId=$ATTEMPT"
```

## Module actions

What an activity can do depends on its module (`moduleKey` in `/courses/{id}/contents`). `POST /activities/{id}/actions/{name}` runs one action with the same checks as the web interface: the activity must be open to you and the action's capability is required. The reference page lists every action with its capability and input schema; the spec carries each schema as `Action.<module>.<action>`. Actions of an activity type turned off in **Administration → Modules** answer `403`; `GET /activities/{id}` answers `404` for such activities.

Actions that take files (assignment `saveSubmission` and `grade`, forum posts, video captions) accept `multipart/form-data`: the JSON input in an `input` part and each file as a `files` part, up to 10 MB per request.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -F 'input={"text":"<p>See the report</p>","submit":true}' \
  -F 'files=@report.pdf;type=application/pdf' \
  https://lms.example.org/api/v1/activities/$ASSIGN/actions/saveSubmission
```

Larger files (a lecture video, a SCORM package) go through a resumable upload. The module action then takes the upload's id:

```bash
# 1. start: the answer has the id and the chunk size (5 MB)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"lecture.mp4","size":734003200,"mimeType":"video/mp4"}' \
  https://lms.example.org/api/v1/uploads
# 2. send the chunks in order; Upload-Offset is the number of bytes already sent
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
  -H "Upload-Offset: 0" --data-binary @chunk-000 \
  https://lms.example.org/api/v1/uploads/$UPLOAD
# 3. hand it to the activity
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"uploadId\":\"$UPLOAD\"}" \
  https://lms.example.org/api/v1/activities/$VIDEO/actions/attachUpload
```

A chunk at the wrong offset answers `409` with `received`, the offset to continue from; `GET /uploads/{id}` tells the same after a lost connection. Unfinished uploads expire after 24 hours.

## Examples

Enrol two users as students:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"userIds":["0199…","0199…"],"roleId":"<student role id>"}' \
  https://lms.example.org/api/v1/courses/$COURSE/enrolments
```

Create a user with a custom profile field:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"ivanov","email":"ivanov@example.org","firstName":"Иван","lastName":"Иванов","password":"…","customFields":{"faculty":"Физфак"}}' \
  https://lms.example.org/api/v1/users
```

Allow one student three quiz attempts and a later deadline:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"0199…","attempts":3,"closeAt":"2026-12-20T21:00:00Z"}' \
  https://lms.example.org/api/v1/activities/$QUIZ/actions/setOverride
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
