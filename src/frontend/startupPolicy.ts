export const DESKTOP_STARTUP_POLICY = {
  blockOnRuntimePackageInstall: false,
  blockOnProductionBuildOrDeploy: false,
  showConnectionSurfaceBeforeAutomaticEnrollment: true,
  savedSessionNetworkTimeoutMs: 8_000,
  connectionStatusTimeoutMs: 2_500
} as const;
