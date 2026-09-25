import http from 'node:http';
import https from 'node:https';

import { errorText } from '../providers.js';

/**
 * OpenRouter speech-to-text, one request per utterance (voice US-004;
 * docs/voice-plan.md §7.1): the WAV goes up base64-encoded in a JSON body, the transcript and
 * what it cost come back.
 *
 * Not `fetch`: Node's global fetch takes no agent, and `undici` is not a
 * dependency. A keep-alive agent per protocol keeps the TLS connection to
 * OpenRouter warm between utterances, which is most of the latency budget
 * of a short clip.
 */

/** docs/voice-plan.md §7.1: OpenRouter's app attribution headers. */
export const OPENROUTER_REFERER = 'https://github.com/vincentBean/chief-web';
export const OPENROUTER_TITLE = 'chief-web voice';

const agents = {
  'http:': new http.Agent({ keepAlive: true }),
  'https:': new https.Agent({ keepAlive: true }),
};

/**
 * `timeout` is `VOICE_STT_TIMEOUT_MS` running out; `http` is a non-2xx answer;
 * `network` is a connection failure or a body that is not a transcript;
 * `unconfigured` is a missing key or a provider the server cannot run.
 */
export type SttErrorKind = 'timeout' | 'http' | 'network' | 'unconfigured';

export class SttError extends Error {
  constructor(
    readonly kind: SttErrorKind,
    /** The provider's HTTP status, or 0 when there was no answer. */
    readonly status: number,
    /** The provider's response body as it came, or `''`. */
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

export interface OpenRouterTranscribeOptions {
  /** e.g. `https://openrouter.ai/api/v1` (`OPENROUTER_API_URL`). */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** ISO 639-1; omitted to let the model detect the language per utterance. */
  readonly language?: string | undefined;
  readonly timeoutMs: number;
  /** The call's cancel (a barge-in or hang-up); rethrown as-is, never an `SttError`. */
  readonly signal?: AbortSignal | undefined;
}

export interface Transcript {
  readonly text: string;
  /** What OpenRouter charged for this request, in USD. */
  readonly costUsd: number;
  /** Audio seconds OpenRouter billed. */
  readonly seconds: number;
}

export async function transcribeWithOpenRouter(wav: Buffer, opts: OpenRouterTranscribeOptions): Promise<Transcript> {
  const body = JSON.stringify({
    model: opts.model,
    input_audio: { data: wav.toString('base64'), format: 'wav' },
    ...(opts.language === undefined ? {} : { language: opts.language }),
  });
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);

  let answer: { status: number; text: string };
  try {
    answer = await post(`${opts.baseUrl}/audio/transcriptions`, body, opts.apiKey, signal);
  } catch (cause) {
    if (opts.signal?.aborted === true) throw cause;
    if (timeout.aborted) {
      throw new SttError('timeout', 0, '', `OpenRouter did not transcribe within ${String(opts.timeoutMs)} ms.`);
    }
    throw new SttError(
      'network',
      0,
      '',
      `OpenRouter could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (answer.status < 200 || answer.status >= 300) {
    throw new SttError(
      'http',
      answer.status,
      answer.text,
      `OpenRouter answered ${String(answer.status)}: ${errorText(answer.text)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    throw new SttError('network', answer.status, answer.text, 'OpenRouter answered with something that is not JSON.');
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (typeof record['text'] !== 'string') {
    throw new SttError('network', answer.status, answer.text, 'OpenRouter answered without a transcript.');
  }
  const usage = typeof record['usage'] === 'object' && record['usage'] !== null ? (record['usage'] as Record<string, unknown>) : {};
  return {
    text: record['text'].trim(),
    costUsd: typeof usage['cost'] === 'number' ? usage['cost'] : 0,
    seconds: typeof usage['seconds'] === 'number' ? usage['seconds'] : 0,
  };
}

function post(url: string, body: string, apiKey: string, signal: AbortSignal): Promise<{ status: number; text: string }> {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  const agent = target.protocol === 'http:' ? agents['http:'] : agents['https:'];
  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: 'POST',
        agent,
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'HTTP-Referer': OPENROUTER_REFERER,
          'X-Title': OPENROUTER_TITLE,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
