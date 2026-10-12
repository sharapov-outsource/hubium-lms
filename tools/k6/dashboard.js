import { check } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';

// 500 requests per second against the REST API endpoints behind the dashboard.
const users = new SharedArray('users', () => JSON.parse(open('./users.json')));
const BASE = __ENV.BASE || 'http://localhost:3000';

export const options = {
  scenarios: {
    dashboard: {
      executor: 'constant-arrival-rate',
      rate: 500,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
  },
  thresholds: { http_req_failed: ['rate<0.005'], http_req_duration: ['p(95)<500'] },
};

export default function () {
  const u = users[Math.floor(Math.random() * users.length)];
  const h = { headers: { Authorization: `Bearer ${u.token}` } };
  const r = http.get(`${BASE}/api/v1/courses`, h);
  check(r, { courses: (x) => x.status === 200 });
  const course = r.json('items.0.id');
  if (course)
    check(http.get(`${BASE}/api/v1/courses/${course}/contents`, h), {
      contents: (x) => x.status === 200,
    });
  check(http.get(`${BASE}/api/v1/notifications?unread=1`, h), {
    notifications: (x) => x.status === 200,
  });
}
