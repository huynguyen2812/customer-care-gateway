/**
 * Deployment mode. `platform` (default) is the VPS edition driven by Platform Admin; `standalone` is the
 * PC edition with local accounts and self-issued credentials. The mode is fixed per Nest module (see
 * StandaloneAppModule) instead of being read from process.env at request time.
 */
export const DEPLOYMENT_MODE = 'DEPLOYMENT_MODE';
export type DeploymentMode = 'platform' | 'standalone';

export function deploymentModeFromEnv(): DeploymentMode {
  return process.env.DEPLOYMENT_MODE === 'standalone' ? 'standalone' : 'platform';
}

/**
 * Jobs later than this many hours past their scheduledAt are cancelled instead of sent
 * (EXPIRED_WHILE_OFFLINE). Standalone defaults to 12 hours; the VPS edition keeps its old behaviour
 * (no limit) unless CARE_JOB_MAX_LATENESS_HOURS is set explicitly.
 */
export function maxLatenessMs(mode: DeploymentMode): number | null {
  const raw = process.env.CARE_JOB_MAX_LATENESS_HOURS;
  const hours = raw !== undefined && raw !== '' ? Number(raw) : mode === 'standalone' ? 12 : NaN;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.min(hours, 24 * 30) * 3600_000;
}
