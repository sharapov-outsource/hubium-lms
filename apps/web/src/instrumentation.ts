export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startCacheListener } = await import('@hubium/core/cache-bus');
    await startCacheListener();
  }
}
