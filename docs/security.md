# Security

This page lists the protections built into Hubium and what an operator should check. Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).

## Built in

| Area | Protection |
|---|---|
| Authentication | Better Auth sessions (HttpOnly, SameSite=Lax cookies), scrypt password hashing, a password policy (length, character classes, no reuse of recent passwords, expiry) checked wherever a password is set, account lockout after repeated failed sign-ins (threshold, window and duration; the owner gets an unlock link, administrators unlock from the user's page), notices of sign-ins from a new browser, system or network with an "it wasn't me" link that ends every session (browsers drop it within the one-minute session cookie cache) and sends a password reset, database-backed rate limiting of auth endpoints in production, TOTP two-factor (can be required for administrators) with backup codes that can be reissued and recovery phrases of the user's own (hashed, each works once, failures count towards the two-factor lockout, use is emailed), OAuth (Google, Yandex, VK) |
| Authorisation | code-defined capabilities checked in core for every operation; roles with overrides per category/course/activity; the API never exceeds the token owner's rights |
| CSRF | server actions check `Origin`; custom route handlers reject cross-site cookie requests (`Sec-Fetch-Site`), except endpoints built for cross-site use (LTI, one-click unsubscribe, bearer API) |
| XSS | rich text sanitised on write (allowlist, iframe hosts limited to known video providers); nonce-based CSP with `strict-dynamic`, no `unsafe-inline` scripts; Markdown for AI and policies rendered without raw HTML |
| Untrusted content | SCORM packages served from a separate origin (`CONTENT_HOST`) with signed short-lived tokens; uploaded files served with `nosniff`, sandboxed CSP and download disposition for active types |
| Framing | `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`; frames allowed only for the content origin, video providers, registered LTI tools and the configured BBB/Jitsi hosts |
| SSRF | server-side fetches of admin/tool URLs (AI endpoints, LTI JWKS) refuse loopback, private, link-local and metadata addresses on every redirect hop unless listed in `SSRF_ALLOW_HOSTS` |
| Secrets | provider keys encrypted at rest with AES-256-GCM under `APP_SECRET`; rotation command; API tokens stored as SHA-256 hashes; LTI keys sealed |
| Uploads | resumable uploads with a maximum size and chunk checks, zip-slip/symlink/size/ratio checks for SCORM and course archives, grade sheets (CSV, XLSX, ODS) capped at 5 MB, 50 MB unpacked and 10,000 rows, read without a spreadsheet library and with XML DOCTYPEs refused, MIME sniffing; optional ClamAV scan of every upload before it is stored, failing closed (uploads are refused while a configured scanner is down) |
| Transport | HSTS in production over HTTPS, `upgrade-insecure-requests`, `Referrer-Policy: strict-origin-when-cross-origin`, restrictive `Permissions-Policy` |
| AI | provider chosen by the administrator, per-feature switches and quotas, consent before first use, pseudonymised grading input, course text and submissions framed as data, suggestions never saved automatically |
| Quizzes | an optional password per quiz (or per participant and group), compared in constant time and never sent to learners; attempts only from allowed network addresses (checked on every step, from the client address of `TRUSTED_PROXY_HOPS`); waits between attempts; sequential navigation enforced on the server |
| Blind marking | markers see participant numbers instead of names in the submission list, the grading panel, notifications and the archive of submissions, and the AI assistant never gets names; grades reach students and the gradebook only once identities are revealed, which cannot be undone; the setting is locked once students submit. Only managers (`mod.assign:viewblinddetails`) see who is who meanwhile. Activity logs and the user ids in grading links are not hidden, as in Moodle |
| Privacy | data export for every user, erasure of personal content on deletion, versioned policies with recorded acceptance; learners see on their privacy page who follows their learning |
| Mentors and parents | off by default; linked only by administrators; see a learner's courses, progress, grades and deadlines exactly as the learner would, never their messages; cannot act for the learner; lose access when the learner is suspended or the feature is turned off |
| Tracing | off unless an OTLP endpoint is set; only W3C trace context is accepted and propagated (no baggage, so nothing a client sends travels into jobs); spans carry routes, queue names and Prisma operations, not request bodies or query parameters |
| Audit | event log of sign-ins, role changes, deletions, token creation, policy publishing, data exports and mentor links |

## Operator checklist

- [ ] `APP_SECRET` is random (`openssl rand -base64 32`) and not shared with other systems.
- [ ] `CONTENT_HOST` is a different domain from `APP_URL` (Admin → Environment shows an error otherwise).
- [ ] The site is served over HTTPS only (the Caddy that `install-hubium.sh` sets up does this).
- [ ] Releases are verified before installing (`install-hubium.sh` checks `SHA256SUMS`; see [releasing.md](releasing.md)), and `hubium doctor` reports no errors.
- [ ] Activity modules nobody uses are turned off (Admin → Modules); turning LTI off also removes LTI tool origins from the CSP.
- [ ] Two-factor authentication is required for administrators (Admin → Settings).
- [ ] Where people upload files from outside, ClamAV scans them (`CLAMAV_URL`; see operations.md, «Антивирус»), and Admin → Environment shows it as OK.
- [ ] Backups of the database and file storage run daily and a restore was tested.
- [ ] Only the hosts that really are internal services are listed in `SSRF_ALLOW_HOSTS`.
- [ ] `METRICS_TOKEN` is long and random, or unset.
- [ ] A privacy policy is published (Admin → Policies); for personal data of Russian citizens check 152-ФЗ: data localisation and, if an external AI provider is used, cross-border transfer consent.
- [ ] Dependencies are scanned (CI runs osv-scanner and CodeQL) and their licenses checked against `tools/licenses/policy.json` (`pnpm licenses:check`).
