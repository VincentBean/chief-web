import type { Config } from '../config.js';
import { claudeAccountBind, type HostPathTranslator } from '../runner/index.js';
import type { CommandResult, CommandRunner } from '../ssh/index.js';

/**
 * Is Claude Code signed in? (US-008)
 *
 * The answer is produced by a **probe container**: a `--rm` runner container
 * with one account's credentials directory mounted, running `claude auth
 * status --json`. That is the CLI's own non-interactive verdict on the
 * credentials in that directory, so it stays right even when the credential file format changes —
 * which parsing `~/.claude/.credentials.json` from the server would not.
 *
 * The probe exits 1 when logged out but still prints its JSON, so the exit code
 * is deliberately ignored in favour of the body.
 */

/** Label put on the probe container, so a stray one is identifiable. */
export const CLAUDE_PROBE_LABEL = 'chief-web.role=claude-auth-probe';

export interface ClaudeAuthStatus {
  /** True only when the CLI itself reports `loggedIn`. */
  readonly authenticated: boolean;
  /** `claude.ai`, `console`, `apiKey`, `none`… as the CLI names it. */
  readonly authMethod: string | null;
  /** Signed-in account's email, when the CLI knows it. */
  readonly account: string | null;
  readonly organization: string | null;
  readonly subscription: string | null;
  /** When this answer was produced (UTC ISO-8601). */
  readonly checkedAt: string;
  /**
   * Why the probe could not answer, or `null` when it did. A status with an
   * error is always `authenticated: false` — chief-web fails closed.
   */
  readonly error: string | null;
}

interface RawStatus {
  loggedIn?: unknown;
  authMethod?: unknown;
  email?: unknown;
  orgName?: unknown;
  subscriptionType?: unknown;
}

/** `docker run` arguments for the probe. Exported so tests can assert them. */
export async function claudeProbeArgs(
  config: Config,
  paths: HostPathTranslator,
  accountId: string,
): Promise<string[]> {
  return [
    'run',
    '--rm',
    '--label',
    CLAUDE_PROBE_LABEL,
    '--volume',
    await claudeAccountBind(config, paths, accountId),
    '--entrypoint',
    'claude',
    config.runnerImage,
    'auth',
    'status',
    '--json',
  ];
}

/** Never throws: a probe that could not run is part of the answer. */
export async function probeClaudeAuth(
  config: Config,
  run: CommandRunner,
  paths: HostPathTranslator,
  accountId: string,
): Promise<ClaudeAuthStatus> {
  let result: CommandResult;
  try {
    const args = await claudeProbeArgs(config, paths, accountId);
    result = await run(config.dockerBin, args, '', config.claudeProbeTimeoutMs);
  } catch (cause) {
    return failedClaudeStatus(`The Claude status check could not be started: ${String(cause)}`);
  }

  if (result.timedOut) {
    const seconds = Math.round(config.claudeProbeTimeoutMs / 1000);
    return failedClaudeStatus(`The Claude status check timed out after ${seconds}s.`);
  }

  const raw = parseStatusJson(result.stdout);
  if (raw === null) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 500);
    return failedClaudeStatus(
      detail === ''
        ? 'The Claude status check produced no output.'
        : `The Claude status check failed: ${detail}`,
    );
  }

  return {
    authenticated: raw.loggedIn === true,
    authMethod: str(raw.authMethod),
    account: str(raw.email),
    organization: str(raw.orgName),
    subscription: str(raw.subscriptionType),
    checkedAt: new Date().toISOString(),
    error: null,
  };
}

/** An `authenticated: false` answer carrying why. */
export function failedClaudeStatus(message: string): ClaudeAuthStatus {
  return {
    authenticated: false,
    authMethod: null,
    account: null,
    organization: null,
    subscription: null,
    checkedAt: new Date().toISOString(),
    error: message,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Pulls the status object out of the probe's stdout. Anything the CLI prints
 * around it (update notices, warnings) is tolerated by taking the outermost
 * braces.
 */
export function parseStatusJson(stdout: string): RawStatus | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as RawStatus;
  } catch {
    return null;
  }
}
