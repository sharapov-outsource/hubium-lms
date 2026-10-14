// Imported first: the command's own output goes to the terminal, so the shared logger only
// reports warnings unless LOG_LEVEL asks for more.
process.env.HUBIUM_SERVICE ??= 'cli';
process.env.LOG_LEVEL ??= 'warn';
