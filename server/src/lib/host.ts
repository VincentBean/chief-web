import fs from 'node:fs';
import os from 'node:os';

/**
 * The machine chief-web itself runs on: how busy its CPUs are and how much of
 * its memory is in use.
 *
 * CPU load is a ratio over an interval, so it needs two samples; the module
 * keeps the previous one and reports the busy fraction since then. The first
 * call after start has nothing to compare against and reports `null`, which
 * the shell renders as "…" — one poll later there is a real number.
 *
 * Inside a container `os` reports the host's CPUs and memory, not the cgroup's
 * share, which is what the status row is asking about. When a memory limit is
 * set, though, `/sys/fs/cgroup` is the honest answer for what the app may use,
 * so that is preferred when readable and lower than the machine's total.
 */
export interface HostLoad {
  /** Busy fraction of all CPUs since the previous sample, 0–1, or `null`. */
  readonly cpu: number | null;
  readonly cores: number;
  readonly memory: { readonly used: number; readonly total: number };
}

interface CpuSample {
  readonly busy: number;
  readonly total: number;
}

let previous: CpuSample | null = null;

function sampleCpu(): CpuSample {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

function readNumber(path: string): number | null {
  try {
    const raw = fs.readFileSync(path, 'utf8').trim();
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** cgroup v2's `memory.current`, in bytes, when this process is limited. */
function cgroupMemory(): { used: number; total: number } | null {
  const limit = readNumber('/sys/fs/cgroup/memory.max');
  const used = readNumber('/sys/fs/cgroup/memory.current');
  if (limit === null || used === null) return null;
  // An unlimited cgroup reports a number far above the machine's memory.
  if (limit >= os.totalmem()) return null;
  return { used, total: limit };
}

/** Reads the current load, and remembers this moment for the next call. */
export function readHostLoad(): HostLoad {
  const sample = sampleCpu();
  const last = previous;
  previous = sample;

  const elapsed = last === null ? 0 : sample.total - last.total;
  const cpu = last === null || elapsed <= 0 ? null : Math.min(1, Math.max(0, (sample.busy - last.busy) / elapsed));

  const total = os.totalmem();
  const memory = cgroupMemory() ?? { used: total - os.freemem(), total };

  return { cpu, cores: os.cpus().length, memory };
}
