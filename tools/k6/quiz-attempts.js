import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';

// 1000 concurrent quiz attempts through the module action API: start, answer, finish.
const users = new SharedArray('users', () => JSON.parse(open('./users.json')));
const BASE = __ENV.BASE || 'http://localhost:3000';
const QUIZ = __ENV.QUIZ;

export const options = {
  scenarios: {
    attempts: { executor: 'per-vu-iterations', vus: 1000, iterations: 1, maxDuration: '15m' },
  },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<800'] },
};

const action = (token, name, body) =>
  http.post(`${BASE}/api/v1/activities/${QUIZ}/actions/${name}`, JSON.stringify(body), {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

export default function () {
  const u = users[__VU - 1];
  const start = action(u.token, 'start', {});
  check(start, { started: (r) => r.status === 200 });
  const attemptId = start.json('data.attemptId');
  if (!attemptId) return;
  // autosave every few seconds while "reading", as the browser does
  for (let i = 0; i < 5; i++) {
    sleep(2 + Math.random() * 4);
    check(action(u.token, 'save', { attemptId, answers: {} }), { saved: (r) => r.status === 200 });
  }
  check(action(u.token, 'finish', { attemptId }), { finished: (r) => r.status === 200 });
}
