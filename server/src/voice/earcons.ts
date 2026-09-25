import fs from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { getVoiceSettings } from '../settings/index.js';
import { synthesizeOnce } from './tts/index.js';
import type { TtsFormat, TtsProviderName } from './tts/types.js';

/**
 * Earcons (voice US-021; plan §3.1): short acknowledgements pre-rendered once
 * per voice, so the call can fill a pause without a provider round trip.
 * They live in `<DATA_DIR>/voice-cache/<voice-id>/<name>.<lang>.pcm` (raw
 * PCM16 LE mono) next to a `manifest.json` saying which provider, model and
 * sample rate made them. A new voice is a new directory; a changed provider,
 * model, rate or wording fails the manifest check and renders again.
 */

export const EARCON_NAMES = ['mm_hm', 'let_me_check', 'one_sec', 'okay', 'sorry'] as const;
export type EarconName = (typeof EARCON_NAMES)[number];

export const EARCON_LANGUAGES = ['nl', 'en'] as const;
export type EarconLanguage = (typeof EARCON_LANGUAGES)[number];

export const EARCON_TEXTS: Readonly<Record<EarconLanguage, Readonly<Record<EarconName, string>>>> = {
  nl: {
    mm_hm: 'Mm-hm.',
    let_me_check: 'Even kijken.',
    one_sec: 'Momentje.',
    okay: 'Oké.',
    sorry: 'Sorry, dat verstond ik niet.',
  },
  en: {
    mm_hm: 'Mm-hm.',
    let_me_check: 'Let me check.',
    one_sec: 'One sec.',
    okay: 'Okay.',
    sorry: "Sorry, I didn't catch that.",
  },
};

/** The acknowledgements the 700 ms rule rotates through. */
export const ACK_EARCONS: readonly EarconName[] = ['mm_hm', 'okay', 'let_me_check'];

/** How many clips render at once: ElevenLabs opens a socket per clip. */
const RENDER_CONCURRENCY = 3;

/** Everything that makes a clip sound the way it does. */
export interface EarconVoice {
  readonly provider: TtsProviderName;
  /** The ElevenLabs voice id, or the OpenRouter voice name. */
  readonly voiceId: string;
  /** The model, and for OpenRouter the requested rate, so a change renders again. */
  readonly model: string;
}

export interface EarconClip {
  readonly name: EarconName;
  readonly language: EarconLanguage;
  readonly sampleRate: number;
  readonly pcm: Buffer;
}

/** Speaks one text start to finish with `voice`'s provider. */
export type EarconRenderer = (voice: EarconVoice, text: string, signal: AbortSignal) => Promise<{ audio: Buffer; format: TtsFormat }>;

interface Manifest {
  readonly provider: TtsProviderName;
  readonly voiceId: string;
  readonly model: string;
  readonly sampleRate: number;
  readonly texts: typeof EARCON_TEXTS;
}

/** The voice the call's provider speaks with, per the voice settings. */
export function earconVoice(db: Database, provider: TtsProviderName): EarconVoice | null {
  const settings = getVoiceSettings(db);
  if (provider === 'elevenlabs') {
    return settings.voiceId === null ? null : { provider, voiceId: settings.voiceId, model: settings.ttsModel };
  }
  return { provider, voiceId: `openrouter-${settings.orTtsVoice}`, model: `${settings.orTtsModel}@${String(settings.orTtsSampleRate)}` };
}

/** `synthesizeOnce` over the stored keys: the renderer production uses. */
export function providerRenderer(db: Database, config: Config): EarconRenderer {
  return (voice, text, signal) => synthesizeOnce(db, config, voice.provider, text, signal);
}

/**
 * The on-disk earcon cache. `load` reads a voice's clips, rendering (and
 * writing) them first when the directory is missing or stale; concurrent
 * loads of one voice share a single render.
 */
export class EarconCache {
  private readonly inFlight = new Map<string, Promise<EarconClip[]>>();

  constructor(
    /** `<DATA_DIR>/voice-cache`. */
    readonly dir: string,
    private readonly render: EarconRenderer,
  ) {}

  /** Every clip of `voice`, both languages. Throws when a clip cannot be rendered. */
  load(voice: EarconVoice, signal: AbortSignal): Promise<EarconClip[]> {
    const dir = this.voiceDir(voice);
    const running = this.inFlight.get(dir);
    if (running !== undefined) return running;
    const run = this.loadInto(dir, voice, signal).finally(() => this.inFlight.delete(dir));
    this.inFlight.set(dir, run);
    return run;
  }

  voiceDir(voice: EarconVoice): string {
    // A voice id is a path segment here; nothing in it may climb out.
    const safe = voice.voiceId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.dir, safe === '' ? '_' : safe);
  }

  private async loadInto(dir: string, voice: EarconVoice, signal: AbortSignal): Promise<EarconClip[]> {
    const cached = await this.read(dir, voice);
    if (cached !== null) return cached;
    return this.renderAll(dir, voice, signal);
  }

  private async read(dir: string, voice: EarconVoice): Promise<EarconClip[] | null> {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    } catch {
      return null;
    }
    if (
      manifest.provider !== voice.provider ||
      manifest.voiceId !== voice.voiceId ||
      manifest.model !== voice.model ||
      JSON.stringify(manifest.texts) !== JSON.stringify(EARCON_TEXTS)
    ) {
      return null;
    }
    try {
      return await Promise.all(
        clipKeys().map(async ({ name, language }) => ({
          name,
          language,
          sampleRate: manifest.sampleRate,
          pcm: await fs.readFile(path.join(dir, fileName(name, language))),
        })),
      );
    } catch {
      return null;
    }
  }

  private async renderAll(dir: string, voice: EarconVoice, signal: AbortSignal): Promise<EarconClip[]> {
    logger.info('rendering voice earcons', { provider: voice.provider, voice: voice.voiceId });
    const keys = clipKeys();
    const clips: EarconClip[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < keys.length) {
        const key = keys[next++] as { name: EarconName; language: EarconLanguage };
        const { audio, format } = await this.render(voice, EARCON_TEXTS[key.language][key.name], signal);
        if (format.kind !== 'pcm16') throw new Error(`Earcons need PCM audio, ${voice.provider} gave ${format.kind}.`);
        clips.push({ ...key, sampleRate: format.sampleRate, pcm: audio });
      }
    };
    await Promise.all(Array.from({ length: RENDER_CONCURRENCY }, worker));
    const sampleRate = clips[0]?.sampleRate ?? 0;
    if (clips.some((clip) => clip.sampleRate !== sampleRate)) throw new Error('Earcons came back at different sample rates.');

    await fs.mkdir(dir, { recursive: true });
    // The manifest goes last: a render cut short leaves no manifest, so it runs again.
    await fs.rm(path.join(dir, 'manifest.json'), { force: true });
    await Promise.all(clips.map((clip) => fs.writeFile(path.join(dir, fileName(clip.name, clip.language)), clip.pcm)));
    const manifest: Manifest = { ...voice, sampleRate, texts: EARCON_TEXTS };
    await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return keys.map(({ name, language }) => clips.find((c) => c.name === name && c.language === language) as EarconClip);
  }
}

/** The call's language when there are clips in it, English otherwise. */
export function earconLanguage(language: string): EarconLanguage {
  return (EARCON_LANGUAGES as readonly string[]).includes(language) ? (language as EarconLanguage) : 'en';
}

function clipKeys(): { name: EarconName; language: EarconLanguage }[] {
  return EARCON_LANGUAGES.flatMap((language) => EARCON_NAMES.map((name) => ({ name, language })));
}

function fileName(name: EarconName, language: EarconLanguage): string {
  return `${name}.${language}.pcm`;
}
