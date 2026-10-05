export interface PasswordHashParams {
  memoryCostKib: number;
  timeCost: number;
  parallelism: number;
}

export interface AuthConfig {
  /** Absolute session lifetime. */
  sessionTtlSeconds: number;
  /** Sessions unused for this long expire (sliding idle timeout). */
  sessionIdleTimeoutSeconds: number;
  emailVerificationTtlSeconds: number;
  passwordResetTtlSeconds: number;
  invitationTtlSeconds: number;
  /** Public URL of the web app; used to build links in emails. */
  appUrl: string;
  password: PasswordHashParams;
}

/** OWASP-recommended argon2id baseline (m = 19 MiB, t = 2, p = 1). */
export const DEFAULT_PASSWORD_PARAMS: PasswordHashParams = {
  memoryCostKib: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function defaultAuthConfig(appUrl: string): AuthConfig {
  return {
    sessionTtlSeconds: 30 * 24 * 3600,
    sessionIdleTimeoutSeconds: 7 * 24 * 3600,
    emailVerificationTtlSeconds: 24 * 3600,
    passwordResetTtlSeconds: 3600,
    invitationTtlSeconds: 7 * 24 * 3600,
    appUrl: appUrl.replace(/\/+$/, ''),
    password: DEFAULT_PASSWORD_PARAMS,
  };
}
