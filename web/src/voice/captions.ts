/**
 * The browser's Web Speech API (voice US-022; plan §7.1 captions, §7.3). Two
 * uses: rough live captions next to OpenRouter STT (`voice_live_captions =
 * browser`; the OpenRouter transcript still counts), and the dev-only
 * `browser` STT provider, whose final results are the transcript. Chrome and
 * Edge only; the audio goes to the browser vendor.
 */

interface RecognitionAlternative {
  readonly transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function browserSpeechAvailable(): boolean {
  return recognitionConstructor() !== null;
}

export interface BrowserSpeechSink {
  /** What is being said now (interim text), or '' once it is final. */
  interim(text: string): void;
  final(text: string): void;
  /** Recognition cannot run (unsupported, microphone refused). */
  failed(reason: string): void;
}

/** Continuous recognition that restarts itself until `stop()`. */
export class BrowserSpeech {
  private recognition: Recognition | null = null;
  private stopped = false;

  constructor(
    private readonly language: string,
    private readonly sink: BrowserSpeechSink,
  ) {}

  start(): void {
    const Ctor = recognitionConstructor();
    if (Ctor === null) {
      this.sink.failed('This browser has no speech recognition.');
      return;
    }
    const recognition = new Ctor();
    recognition.lang = this.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result?.[0]?.transcript.trim() ?? '';
        if (result === undefined || text === '') continue;
        if (result.isFinal) this.sink.final(text);
        else interim += `${interim === '' ? '' : ' '}${text}`;
      }
      this.sink.interim(interim);
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.stopped = true;
        this.sink.failed(`Speech recognition was refused (${event.error}).`);
      }
    };
    // Chrome ends a continuous session after a while of silence; keep going.
    recognition.onend = () => {
      if (!this.stopped) {
        try {
          recognition.start();
        } catch {
          // Already starting.
        }
      }
    };
    this.recognition = recognition;
    recognition.start();
  }

  stop(): void {
    this.stopped = true;
    this.recognition?.abort();
    this.recognition = null;
  }
}
