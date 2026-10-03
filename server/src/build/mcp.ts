import type { ExecSpec } from '../docker/index.js';
import { AGENT_PID_DIR } from './agent.js';

/**
 * The one MCP server a build iteration gets: `chief`, offering `ask_operator`
 * and nothing else (decisions US-003).
 *
 * The session voice agent's config (`voice/session-agent/process.ts`) is the
 * model for this, and deliberately not reused. That one hands its agent a
 * browser and, while planning, `start_build`; a build iteration has no
 * business with either — it is already building, and there is nobody watching
 * a browser with it. What it does need is a way to ask a question, so the
 * `chief` server is started with `CHIEF_MCP_ASK_OPERATOR=1`, which is also
 * what makes that server hide its browser tool (`runner/chief-mcp.js`).
 *
 * Every iteration is launched with `--mcp-config` pointing at the file below,
 * written into the container immediately before the launch so a timeout
 * changed on the settings page reaches the next iteration rather than the next
 * restart.
 */

/** Where the `ask_operator` request and answer files meet, next to the pid files. */
export const DECISION_ASK_DIR = `${AGENT_PID_DIR}/ask`;

/** The `--mcp-config` file of a build iteration. */
export const BUILD_MCP_CONFIG_FILE = `${AGENT_PID_DIR}/mcp.json`;

/** The build agent's user, and so its MCP server's: the runner image's `node`. */
export const BUILD_AGENT_USER = '1000';

/** `node /usr/local/lib/chief-web/chief-mcp.js`, as the runner image ships it. */
export const CHIEF_MCP_COMMAND: readonly string[] = ['node', '/usr/local/lib/chief-web/chief-mcp.js'];

export interface BuildMcpConfigOptions {
  /**
   * How long `ask_operator` waits for an answer. The same number stops the
   * iteration's own clock (`build/decisions.ts`), so it is passed in from
   * there rather than defaulted twice.
   */
  readonly askTimeoutMs: number;
  /** Only `__fixtures__` and tests swap the argv. */
  readonly command?: readonly string[];
}

/** The `--mcp-config` JSON: one stdio server, with `ask_operator` turned on. */
export function buildMcpConfig(options: BuildMcpConfigOptions): string {
  const argv = options.command ?? CHIEF_MCP_COMMAND;
  return JSON.stringify({
    mcpServers: {
      chief: {
        type: 'stdio',
        command: argv[0] as string,
        args: argv.slice(1),
        env: {
          CHIEF_MCP_ASK_OPERATOR: '1',
          CHIEF_MCP_ASK_DIR: DECISION_ASK_DIR,
          CHIEF_MCP_ASK_TIMEOUT_MS: String(options.askTimeoutMs),
          // Said out loud as well, though the server enforces it: a build
          // iteration is not a voice call — no browser, and nothing to build
          // that it is not already inside.
          CHIEF_MCP_START_BUILD: '0',
        },
      },
    },
  });
}

/**
 * Writes {@link buildMcpConfig} to {@link BUILD_MCP_CONFIG_FILE} as the build
 * agent's own user. The JSON goes in as a positional argument and is printed
 * with `printf '%s'`, so nothing in it is ever re-parsed by the shell.
 */
export function buildMcpConfigWriteSpec(options: BuildMcpConfigOptions): ExecSpec {
  return {
    cmd: [
      '/bin/sh',
      '-c',
      `mkdir -p ${DECISION_ASK_DIR} && printf '%s' "$1" > ${BUILD_MCP_CONFIG_FILE}`,
      'chief-build-mcp',
      buildMcpConfig(options),
    ],
    user: BUILD_AGENT_USER,
  };
}
