import '@hubium/core/bootstrap';
import { registerModules } from '@hubium/core';
import { contentModules } from '@hubium/mod-content/server';

// Server-side module registry (also imported by the worker). Keep in sync with ./ui.tsx.
export const serverModules = [...contentModules];
registerModules(serverModules as never);
