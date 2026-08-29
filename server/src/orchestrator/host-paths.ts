import path from 'node:path';

import type { Config } from '../config.js';
import type { VolumeDetails } from '../docker/index.js';

/**
 * Translates a path the *server* can see into the path the Docker daemon has
 * to be given for it.
 *
 * The daemon resolves bind-mount sources on the **host**. Inside Docker the
 * server's `/data` is a named volume, and `/data/workspaces/<id>` means nothing
 * on the host — so the volume's host mountpoint is looked up once and the
 * remainder of the path appended to it. Outside Docker there is no volume and
 * the path is already a host path.
 *
 * This is the per-directory version of the by-name volume mount the shared
 * credentials use (`claudeAuthSource`), which cannot express a subdirectory.
 */
export class HostPaths {
  private mountpoint: Promise<string> | null = null;

  constructor(
    private readonly config: Pick<Config, 'dataDir' | 'dataVolume'>,
    private readonly docker: { inspectVolume(name: string): Promise<VolumeDetails> },
  ) {}

  async translate(insideServer: string): Promise<string> {
    if (this.config.dataVolume === '') return insideServer;

    const relative = path.relative(this.config.dataDir, insideServer);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `"${insideServer}" is not inside DATA_DIR (${this.config.dataDir}), so it cannot be mounted into a session container.`,
      );
    }

    // Cached: the mountpoint of a volume cannot change while it is mounted. A
    // failed lookup is not cached, so a daemon that was briefly down recovers.
    this.mountpoint ??= this.docker
      .inspectVolume(this.config.dataVolume)
      .then((volume) => volume.mountpoint)
      .catch((cause: unknown) => {
        this.mountpoint = null;
        throw cause;
      });

    const base = await this.mountpoint;
    return path.posix.join(base, relative.split(path.sep).join('/'));
  }
}
