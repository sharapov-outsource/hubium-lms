import './service.ts';

// The worker process: the queues and schedules (worker.ts), or on a local node its agent
// (node/agent.ts), which passes the node's changes on to the cloud and runs the node
// without a connection (docs/architecture.md §1.7).
if (process.env.HUBIUM_ROLE === 'node') await import('./node/agent.ts');
else await import('./worker.ts');
