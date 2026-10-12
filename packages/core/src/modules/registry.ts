import type { ActivityModule } from '@hubium/module-sdk';

// Compile-time module registry, injected at startup by web and worker
// (core never imports modules; see dependency rules).

const modules = new Map<string, ActivityModule<unknown>>();

export function registerModules(list: ActivityModule<never>[]): void {
  for (const m of list) modules.set(m.key, m as unknown as ActivityModule<unknown>);
}

export function getModule(key: string): ActivityModule<unknown> | undefined {
  return modules.get(key);
}

export function requireModule(key: string): ActivityModule<unknown> {
  const m = modules.get(key);
  if (!m) throw new Error(`Unknown activity module: ${key}`);
  return m;
}

export function listModules(): ActivityModule<unknown>[] {
  return [...modules.values()];
}
