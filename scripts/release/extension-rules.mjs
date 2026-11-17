// Native/Bridge commits have their own release streams in this monorepo.
export const releaseRules = [
  "bridge", "desktop", "macos", "windows", "linux", "protocol", "runtime", "platforms",
].map(scope => ({scope, release:false}));
