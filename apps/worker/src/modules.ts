import '@hubium/core/bootstrap';
import { registerModules } from '@hubium/core';
import { serverModules } from '@hubium/modules';

// The same server-side registry as the web app's.
export { serverModules };

registerModules(serverModules as never);
