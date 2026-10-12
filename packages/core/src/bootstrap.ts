// Side-effect imports that wire core services together. Import once at process start
// (web and worker) after registering modules.
import './completion/completion.ts';
import './courses/file-access.ts';
