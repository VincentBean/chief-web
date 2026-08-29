import type { Config } from '../config.js';
import { claudeAuthSource, RUNNER_CLAUDE_DIR, RUNNER_HOME } from '../runner/index.js';

/**
 * The one-time `claude auth login` (US-008, FR-5).
 *
 * Signing in needs a real TTY — the CLI prints an OAuth URL and then waits for
 * the code to be pasted back — so it runs in a browser terminal (US-007) inside
 * a throwaway runner container. The only thing that container has mounted is
 * the shared `claude-auth` volume, which is exactly where the credentials must
 * land: every session container mounts the same volume at `~/.claude`, so one
 * login authenticates all of them, and it survives `docker compose down`
 * because a named volume outlives the containers using it.
 */

/**
 * Fixed name so a container left behind by a server restart is found and
 * replaced rather than duplicated.
 */
export const CLAUDE_LOGIN_CONTAINER_NAME = 'chief-web-claude-login';

export const CLAUDE_LOGIN_LABEL = 'chief-web.role=claude-login';

/**
 * Runs in the login terminal. `claude auth login` on its own would leave the
 * pane on a bare exited shell, so the outcome is spelled out afterwards and the
 * CLI's own status is printed as confirmation.
 */
const LOGIN_SCRIPT = `echo "chief-web: signing Claude Code in. Open the URL below, approve it, then paste"
echo "the code back here. Credentials are written to the shared claude-auth volume."
echo
claude auth login
code=$?
echo
claude auth status --text 2>&1 || true
echo
if [ "$code" -eq 0 ]; then
  echo "Login finished — close this terminal to continue."
else
  echo "claude auth login exited with $code — close this terminal and try again."
fi`;

export const CLAUDE_LOGIN_COMMAND: readonly string[] = ['/bin/sh', '-c', LOGIN_SCRIPT];

/** Working directory of the login terminal: the user's home, not `/workspace`. */
export const CLAUDE_LOGIN_CWD = RUNNER_HOME;

/**
 * `docker run` arguments for the login container: detached, idling on the
 * image's default command, with only the credentials volume attached. The
 * terminal is `docker exec`ed into it afterwards, the same way session
 * containers are driven.
 */
export function claudeLoginContainerArgs(config: Config): string[] {
  return [
    'run',
    '--detach',
    '--name',
    CLAUDE_LOGIN_CONTAINER_NAME,
    '--label',
    CLAUDE_LOGIN_LABEL,
    '--volume',
    `${claudeAuthSource(config)}:${RUNNER_CLAUDE_DIR}`,
    config.runnerImage,
  ];
}

/**
 * `docker rm -f`, used both to clean up and to clear a stale name. `-v` is
 * deliberately absent: the credentials volume must outlive the container.
 */
export function removeContainerArgs(nameOrId: string): string[] {
  return ['rm', '--force', nameOrId];
}
