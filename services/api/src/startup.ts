/**
 * API startup diagnostics. Startup runs as named steps; when one fails the process prints exactly
 * one JSON line on stderr naming it, then exits non-zero:
 *
 *   {"startup":"failed","step":"sandbox_image_inspect","code":"image_missing","hint":"…"}
 *
 * `code` is a fixed identifier (a step reason, an API error code, a PostgreSQL SQLSTATE or a
 * socket error code), never an error message, so no connection string, path or secret can leak.
 * `hint` is fixed operator text chosen by step and code. A successful start prints each step's
 * duration as one line at debug level (LOG_LEVEL=debug). See docs/startup-diagnostics.md.
 */
export const STARTUP_STEPS = ['configuration', 'db_connect', 'migrations', 'provider_configuration', 'docker_info', 'sandbox_image_inspect',
  'verifier_qualification', 'object_store', 'server_setup', 'port_bind'] as const;
export type StartupStep = (typeof STARTUP_STEPS)[number];

/** A step's own failure with a chosen code (and, for configuration only, our own message). */
export class StartupError extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(code); }
}
/** A configuration problem whose message is fixed text written in this codebase (never a value). */
export class ConfigurationError extends StartupError {
  constructor(message: string) { super('INVALID_CONFIGURATION', message); }
}

const CODE = /^[A-Za-z0-9_]{1,64}$/;
/** The fixed identifier of an error: ours, an ApiError's, a SQLSTATE or a socket code. */
export function failureCode(error: unknown): string {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' && CODE.test(value) ? value : 'UNKNOWN';
}

const HINTS: Record<StartupStep, Record<string, string>> = {
  configuration: { default: 'A setting is missing or invalid; the detail names it. Fix the environment and start again.' },
  db_connect: {
    ECONNREFUSED: 'PostgreSQL is not accepting connections at the host and port in DATABASE_URL. Start it or correct the address.',
    ENOTFOUND: 'The database host in DATABASE_URL does not resolve. Correct the host name.',
    ETIMEDOUT: 'PostgreSQL did not answer in time. Check that it is running and reachable from this machine.',
    '28P01': 'PostgreSQL refused the user or password in DATABASE_URL.',
    '28000': 'PostgreSQL refused this connection (pg_hba.conf). Allow the API user from this host.',
    '3D000': 'The database named in DATABASE_URL does not exist. Create it, then start again.',
    '57P03': 'PostgreSQL is still starting. Start the API again once it accepts connections.',
    default: 'The API could not open its database. Check that PostgreSQL is running and DATABASE_URL is right.',
  },
  migrations: {
    '42501': 'The migration account lacks a privilege. Run migrations as the schema owner (MIGRATION_DATABASE_URL).',
    RUNTIME_PRIVILEGES: 'DATABASE_URL must name a least-privilege runtime user (not a superuser or the schema owner) when MIGRATION_DATABASE_URL is set.',
    MIGRATION_CHANGED: 'A migration file differs from the one this database already applied. Restore the released file; never edit an applied migration.',
    default: 'A database migration did not apply. All migrations run in one transaction, so none of this run was kept; check the database log and start again.',
  },
  provider_configuration: { default: 'PROVIDER_CONFIG_FILE could not be read or is not a valid provider configuration. Correct the file or unset it.' },
  docker_info: {
    docker_not_installed: 'The Docker command is not installed or not on PATH. Install Docker, or unset CODE_FIXTURE_FILES, TEACHING_VERIFIER_FILES and COURSE_SUPPLIED_CODE_FIXTURES.',
    docker_unavailable: 'Docker is installed but its daemon did not answer. Start Docker Desktop (or the daemon) and start the API again.',
    docker_timeout: 'Docker did not answer within SANDBOX_STARTUP_TIMEOUT_MS. Docker may still be starting; raise the timeout or start the API once Docker is up.',
    required_isolation_unavailable: 'This Docker does not offer the isolation the grading sandbox requires (Linux containers with memory, CPU and process limits and seccomp).',
    default: 'Docker is not ready for the grading sandbox.',
  },
  sandbox_image_inspect: {
    image_missing: 'The pinned sandbox image is not on this machine. Pull it (npm run sandbox:pull) or set COURSE_SANDBOX_IMAGE to an image you have.',
    image_inspect_timeout: 'Docker did not describe the sandbox image within SANDBOX_STARTUP_TIMEOUT_MS. Docker may be overloaded; raise the timeout.',
    native_image_architecture_required: 'The sandbox image is not built for this machine\'s architecture. Use the image pinned for this platform.',
    default: 'The pinned sandbox image is not usable.',
  },
  verifier_qualification: {
    TEACHING_VERIFIER_QUALIFICATION_FAILED: 'A teaching verifier failed its own qualification cases, so it was not installed. Fix the file or remove it from TEACHING_VERIFIER_FILES.',
    TEACHING_VERIFIER_QUALIFICATION_TIMEOUT: 'A teaching verifier\'s qualification kept timing out until SANDBOX_STARTUP_TIMEOUT_MS. Docker is likely slow to start containers; raise the timeout. Qualification is never skipped.',
    TEACHING_VERIFIER_SANDBOX_UNAVAILABLE: 'The grading sandbox stayed unavailable until SANDBOX_STARTUP_TIMEOUT_MS, so no teaching verifier could be qualified. Qualification is never skipped.',
    default: 'A code fixture or teaching verifier file could not be loaded and qualified. Check the files named in CODE_FIXTURE_FILES and TEACHING_VERIFIER_FILES.',
  },
  object_store: { default: 'The artifact object store (COURSE_ARTIFACT_STORE) is not reachable. Check its endpoint and credentials, or unset it.' },
  server_setup: { default: 'The API could not set up its routes with this configuration. Check the settings changed most recently.' },
  port_bind: {
    EADDRINUSE: 'Another process already listens on API_HOST:PORT. Stop it or choose another PORT.',
    EACCES: 'This user may not listen on PORT. Use a port above 1023 or run behind a proxy.',
    EADDRNOTAVAIL: 'API_HOST is not an address of this machine. Use 127.0.0.1 or an address this host has.',
    default: 'The API could not listen on API_HOST:PORT.',
  },
};
export function startupHint(step: StartupStep, code: string) { return HINTS[step][code] ?? HINTS[step].default!; }

/** Our own fixed configuration text: letters, digits and punctuation, no URL, at most 200 characters. */
const SAFE_DETAIL = /^[A-Za-z0-9 _.,:;()'"=<>/+-]{1,200}$/;
export function failureLine(step: StartupStep, error: unknown): string {
  const code = failureCode(error);
  const detail = error instanceof StartupError && error.detail && SAFE_DETAIL.test(error.detail) && !error.detail.includes('://') ? error.detail : undefined;
  return JSON.stringify({ startup: 'failed', step, code, hint: startupHint(step, code), ...(detail ? { detail } : {}) });
}

/** Runs startup steps in order, timing each; the first failure is reported once. */
export class Startup {
  private readonly timings: Partial<Record<StartupStep, number>> = {};
  private readonly started = performance.now();
  constructor(private readonly write: (line: string) => void = line => process.stderr.write(`${line}\n`)) {}
  async step<T>(name: StartupStep, body: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await body(); }
    catch (error) { throw error instanceof StepFailure ? error : new StepFailure(name, error); }
    finally { this.timings[name] = Math.round((this.timings[name] ?? 0) + performance.now() - started); }
  }
  /** Prints the one failure line; the caller exits non-zero. */
  failed(error: unknown) {
    this.write(error instanceof StepFailure ? failureLine(error.step, error.cause) : failureLine('server_setup', error));
  }
  /** A problem that does not stop the API (it starts degraded): one line, same fields. */
  degraded(step: StartupStep, code: string) {
    this.write(JSON.stringify({ startup: 'degraded', step, code, hint: startupHint(step, code) }));
  }
  /** Per-step timings, written only at debug level. */
  ready(level = process.env.LOG_LEVEL) {
    if (level !== 'debug') return;
    this.write(JSON.stringify({ startup: 'ready', level: 'debug', totalMs: Math.round(performance.now() - this.started), steps: this.timings }));
  }
}
export class StepFailure extends Error {
  constructor(readonly step: StartupStep, override readonly cause: unknown) { super(`startup_${step}`); }
}

/**
 * Retries `attempt` while it fails for a reason `retryable` accepts, until `deadlineMs` after the
 * first try, with backoff from 1 s to 5 s. The last failure is thrown, never swallowed: a slow
 * Docker gets time to come up, but nothing that needs qualifying is ever installed unqualified.
 */
export async function untilReady<T>(attempt: () => Promise<T>, retryable: (error: unknown) => boolean, deadlineMs: number,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (let delay = 1_000; ; delay = Math.min(delay * 2, 5_000)) {
    try { return await attempt(); }
    catch (error) {
      if (!retryable(error) || Date.now() + delay >= deadline) throw error;
      await sleep(delay);
    }
  }
}
/** SANDBOX_STARTUP_TIMEOUT_MS: how long startup waits for Docker and qualification (default 2 minutes). */
export function sandboxStartupTimeout(value: string | undefined) {
  const ms = Number(value ?? 120_000);
  if (!Number.isInteger(ms) || ms < 5_000 || ms > 900_000) throw new ConfigurationError('SANDBOX_STARTUP_TIMEOUT_MS must be an integer from 5000 to 900000.');
  return ms;
}
