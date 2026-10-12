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

## Versioning

Breaking changes go to `/api/v2`. Endpoints scheduled for removal answer with a `Deprecation` header at least six months in advance; additive changes (new fields, new endpoints) happen within v1.
