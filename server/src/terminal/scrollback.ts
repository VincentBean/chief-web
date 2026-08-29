/**
 * Server-side replay buffer for a terminal (FR: "at least the last 500 lines").
 *
 * The browser is a thin view: it holds no authoritative history, so a reload —
 * or a laptop that slept through a build — gets the tail of the session
 * replayed from here.
 *
 * Output is kept as raw bytes, never decoded: a UTF-8 sequence or an ANSI
 * escape can be split across two reads from the PTY, and re-encoding halves of
 * one would corrupt the stream. Trimming happens only on newline boundaries for
 * the same reason — cutting inside an escape sequence would leave the client's
 * parser in an undefined state.
 */
export class ScrollbackBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private lines = 0;

  constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
  ) {}

  get byteLength(): number {
    return this.bytes;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.lines += countNewlines(chunk);
    if (this.lines > this.maxLines || this.bytes > this.maxBytes) this.trim();
  }

  /** Everything retained, oldest first, as one buffer. */
  snapshot(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
    this.lines = 0;
  }

  private trim(): void {
    const merged = this.snapshot();
    let cut = 0;
    let dropped = 0;

    // Drop whole lines from the front until both budgets are satisfied. The
    // byte budget can only be met by dropping a line, so a single line longer
    // than `maxBytes` is kept intact rather than sliced mid-escape.
    while (this.lines - dropped > this.maxLines || merged.length - cut > this.maxBytes) {
      const newline = merged.indexOf(0x0a, cut);
      if (newline === -1) break;
      cut = newline + 1;
      dropped += 1;
    }

    if (cut === 0) return;
    this.chunks = [merged.subarray(cut)];
    this.bytes = merged.length - cut;
    this.lines -= dropped;
  }
}

function countNewlines(chunk: Buffer): number {
  let count = 0;
  for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) {
    count += 1;
  }
  return count;
}
