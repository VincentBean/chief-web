/**
 * Push-to-talk (voice US-009; docs/voice-plan.md §13.2–13.3): while Space or the
 * hold-to-talk button is down, the capture worklet's PCM16 batches are
 * collected; on release they go to the server as one WAV. No VAD involved.
 */
import { MAX_UTTERANCE_MS } from './vad.ts';
import { encodeWavPcm16, WAV_SAMPLE_RATE } from './wav.ts';

/** The server rejects anything shorter as a misfire; don't send it. */
const MIN_UTTERANCE_SAMPLES = (250 / 1000) * WAV_SAMPLE_RATE;
const MAX_UTTERANCE_SAMPLES = (MAX_UTTERANCE_MS / 1000) * WAV_SAMPLE_RATE;
/** A full worklet batch; the reply to `'flush'` is always shorter. */
const WORKLET_BATCH_BYTES = 1600 * 2;
const FLUSH_TIMEOUT_MS = 250;

export class PushToTalkRecorder {
  private chunks: Int16Array<ArrayBuffer>[] = [];
  private samples = 0;
  private recording = false;
  private flushed: (() => void) | null = null;

  constructor(
    private readonly node: AudioWorkletNode,
    private readonly onUtterance: (wav: ArrayBuffer) => void,
  ) {
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => this.onBatch(event.data);
  }

  get active(): boolean {
    return this.recording;
  }

  start(): void {
    if (this.recording) return;
    this.chunks = [];
    this.samples = 0;
    this.recording = true;
  }

  /** Sends what was collected (plus the worklet's partial batch) as one WAV. */
  async stop(): Promise<void> {
    if (!this.recording) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.flushed = done;
      this.node.port.postMessage('flush');
    });
    this.flushed = null;
    this.recording = false;
    this.emit();
  }

  /** Drops what was collected without sending it. */
  cancel(): void {
    this.recording = false;
    this.chunks = [];
    this.samples = 0;
  }

  private onBatch(buffer: ArrayBuffer): void {
    const flushReply = this.flushed !== null && buffer.byteLength < WORKLET_BATCH_BYTES;
    if (this.recording) {
      const batch = new Int16Array(buffer);
      this.chunks.push(batch);
      this.samples += batch.length;
      // Force-split at 55 s and keep collecting.
      if (this.samples >= MAX_UTTERANCE_SAMPLES) this.emit();
    }
    if (flushReply) this.flushed?.();
  }

  private emit(): void {
    const chunks = this.chunks;
    const length = this.samples;
    this.chunks = [];
    this.samples = 0;
    if (length < MIN_UTTERANCE_SAMPLES) return;
    const pcm = new Int16Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    this.onUtterance(encodeWavPcm16(pcm));
  }
}

/**
 * True for elements that take typed text: inputs, text areas, selects,
 * contenteditable, and the xterm terminal (whose helper textarea is caught by
 * the tag check, but the container also handles keys).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, [data-captures-keys]')) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Space as push-to-talk. It acts only while focus is inside the call panel,
 * or anywhere when `global()` is true (`voice_ptt_global`), and never on an
 * editable element, so typing in inputs or the terminal is untouched. A
 * release is also forced on window blur or when the tab is hidden, so a lost
 * key-up cannot leave the microphone collecting. Returns the uninstaller.
 */
export function installSpaceToTalk(opts: {
  panel: () => HTMLElement | null;
  global: () => boolean;
  down: () => void;
  up: () => void;
}): () => void {
  let held = false;

  const applies = (event: KeyboardEvent): boolean => {
    if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return false;
    const target = event.target instanceof Element ? event.target : document.activeElement;
    if (isEditableTarget(target)) return false;
    if (opts.global()) return true;
    const panel = opts.panel();
    return panel !== null && target instanceof Node && panel.contains(target);
  };
  const release = (): void => {
    if (!held) return;
    held = false;
    opts.up();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' || (!held && !applies(event))) return;
    // Also swallows the auto-repeat and the page scroll / button click.
    event.preventDefault();
    if (held || event.repeat) return;
    held = true;
    opts.down();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' || !held) return;
    event.preventDefault();
    release();
  };
  const onVisibility = (): void => {
    if (document.hidden) release();
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    release();
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', release);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Wires a hold-to-talk button to pointer presses; returns the unbinder. Space
 * on the focused button is already push-to-talk, since it sits in the panel.
 */
export function bindHoldToTalkButton(button: HTMLElement, down: () => void, up: () => void): () => void {
  let held = false;
  const press = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    if (held) return;
    held = true;
    down();
  };
  const release = (): void => {
    if (!held) return;
    held = false;
    up();
  };
  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
  return () => {
    release();
    button.removeEventListener('pointerdown', press);
    button.removeEventListener('pointerup', release);
    button.removeEventListener('pointercancel', release);
    button.removeEventListener('lostpointercapture', release);
  };
}
