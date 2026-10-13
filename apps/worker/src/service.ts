// Imported first by main.ts: names this process in every log record before the logger is
// created (compose sets HUBIUM_SERVICE explicitly; this covers local runs).
const queues = (process.env.WORKER_QUEUES ?? 'default').split(',').map((s) => s.trim());
process.env.HUBIUM_SERVICE ??= queues.includes('default') ? 'worker' : 'worker-media';
