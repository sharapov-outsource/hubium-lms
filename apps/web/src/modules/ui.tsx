import { contentModuleUIs } from '@hubium/mod-content/ui';
import type { ActivityModuleUI } from '@hubium/module-sdk/ui';

const uis = new Map<string, ActivityModuleUI<never>>();
for (const ui of [...contentModuleUIs]) uis.set(ui.key, ui as unknown as ActivityModuleUI<never>);

export function getModuleUI(key: string): ActivityModuleUI<never> | undefined {
  return uis.get(key);
}

export const moduleUIKeys = [...uis.keys()];
