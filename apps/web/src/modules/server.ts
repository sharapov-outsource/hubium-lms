import '@hubium/core/bootstrap';
import { registerModules } from '@hubium/core';
import { serverModules } from '@hubium/modules';

// Server-side module registry (the list lives in @hubium/modules; the UI side in ./ui.tsx).
export { serverModules };

registerModules(serverModules as never);
