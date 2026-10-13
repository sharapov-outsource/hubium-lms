/** What this build is; next.config.ts sets the values when the app is built. */
export const buildInfo = {
  version: process.env.HUBIUM_VERSION || '0.0.0',
  /** Short commit hash, when known. */
  commit: process.env.HUBIUM_COMMIT || null,
  /** ISO time of the build. */
  builtAt: process.env.HUBIUM_BUILT_AT || null,
};
