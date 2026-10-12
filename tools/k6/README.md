# Load tests (k6)

Reference targets on an 8 vCPU / 16 GB box (web ×2, worker ×1, PostgreSQL on the same host):

| Scenario | Target |
|---|---|
| `quiz-attempts.js` — 1000 students take a quiz at once (start, save answers, finish) | p95 < 800 ms, errors < 1 % |
| `dashboard.js` — signed-in dashboard and course page at 500 requests/s | p95 < 500 ms, errors < 0.5 % |

## Preparing data

```bash
pnpm db:seed --profile demo
pnpm --filter @hubium/core k6:prepare 1000   # creates load-test users + API tokens
```

`k6-prepare.ts` enrols `load0001…` users into DEMO-PY and writes `tools/k6/users.json` with API tokens.

## Running

```bash
k6 run -e BASE=https://lms.example.org tools/k6/dashboard.js
k6 run -e BASE=https://lms.example.org -e QUIZ=<activity id> tools/k6/quiz-attempts.js
```

Watch `/api/metrics` and `pg_stat_statements` while the test runs.
