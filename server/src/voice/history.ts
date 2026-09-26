import { Router } from 'express';

import {
  type Database,
  deleteVoiceCall,
  getVoiceCall,
  listVoiceCalls,
  listVoiceTurnsWithSessions,
  type VoiceCall,
  type VoiceEndReason,
  type VoiceSpeaker,
  type VoiceTurnWithSession,
} from '../db/index.js';

/**
 * Call history (voice US-024): the past calls and their transcripts, read
 * back from `voice_calls` / `voice_turns`, and deleting one by hand. The
 * scheduler's retention sweep deletes the rest; audio was never stored.
 */

export const DEFAULT_CALL_LIMIT = 50;
export const MAX_CALL_LIMIT = 500;

export interface VoiceCallSummaryView {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Up to `now` for the call still running (or left open by a crash). */
  readonly durationSeconds: number;
  readonly endReason: VoiceEndReason | null;
  /** The call running right now; it cannot be deleted. */
  readonly active: boolean;
  readonly providers: { readonly stt: string; readonly tts: string };
  readonly cost: {
    readonly elChars: number;
    readonly sttSeconds: number;
    readonly scribeSeconds: number;
    readonly orCostUsd: number;
    readonly claudeTurns: number;
  };
}

export interface VoiceToolEventView {
  readonly name: string;
  readonly status: string;
  readonly summary: string;
}

export interface VoiceTurnView {
  readonly id: number;
  readonly turn: number;
  readonly speaker: VoiceSpeaker;
  readonly sessionId: string | null;
  readonly sessionName: string | null;
  readonly text: string;
  readonly interrupted: boolean;
  readonly tools: readonly VoiceToolEventView[];
  readonly latency: {
    readonly speechEnd: string | null;
    readonly transcript: string | null;
    readonly firstToken: string | null;
    readonly firstChunk: string | null;
    readonly firstAudioSent: string | null;
    readonly firstAudioPlayed: string | null;
  };
  readonly createdAt: string;
}

export function callSummaryView(call: VoiceCall, activeCallId: string | null, now: number): VoiceCallSummaryView {
  const end = call.endedAt === null ? now : Date.parse(call.endedAt);
  return {
    id: call.id,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationSeconds: Math.max(0, Math.round((end - Date.parse(call.startedAt)) / 1000)),
    endReason: call.endReason,
    active: call.id === activeCallId,
    providers: { stt: call.sttProvider, tts: call.ttsProvider },
    cost: {
      elChars: call.elChars,
      sttSeconds: call.sttSeconds,
      scribeSeconds: call.scribeSeconds,
      orCostUsd: call.orCostUsd,
      claudeTurns: call.claudeTurns,
    },
  };
}

/** `tools_json` as written by the call; anything malformed reads as no tools. */
function parseTools(json: string | null): VoiceToolEventView[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null) return [];
      const { name, status, summary } = item as Record<string, unknown>;
      if (typeof name !== 'string') return [];
      return [
        {
          name,
          status: typeof status === 'string' ? status : 'ok',
          summary: typeof summary === 'string' ? summary : '',
        },
      ];
    });
  } catch {
    return [];
  }
}

export function turnView(turn: VoiceTurnWithSession): VoiceTurnView {
  return {
    id: turn.id,
    turn: turn.turn,
    speaker: turn.speaker,
    sessionId: turn.sessionId,
    sessionName: turn.sessionName,
    text: turn.text,
    interrupted: turn.interrupted,
    tools: parseTools(turn.toolsJson),
    latency: {
      speechEnd: turn.tSpeechEnd,
      transcript: turn.tTranscript,
      firstToken: turn.tFirstToken,
      firstChunk: turn.tFirstChunk,
      firstAudioSent: turn.tFirstAudioSent,
      firstAudioPlayed: turn.tFirstAudioPlayed,
    },
    createdAt: turn.createdAt,
  };
}

function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_CALL_LIMIT;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const limit = Number.parseInt(raw, 10);
  return limit >= 1 ? Math.min(limit, MAX_CALL_LIMIT) : null;
}

export function createVoiceHistoryRouter(
  db: Database,
  activeCallId: () => string | null,
  now: () => number = Date.now,
): Router {
  const router = Router();

  router.get('/voice/calls', (req, res) => {
    const limit = parseLimit(req.query['limit']);
    if (limit === null) {
      res.status(400).json({ error: 'invalid_limit', message: 'limit must be a whole number of at least 1.' });
      return;
    }
    const active = activeCallId();
    const at = now();
    res.status(200).json({ calls: listVoiceCalls(db, limit).map((call) => callSummaryView(call, active, at)) });
  });

  router.get('/voice/calls/:id', (req, res) => {
    const call = getVoiceCall(db, req.params.id);
    if (call === null) {
      res.status(404).json({ error: 'call_not_found', message: 'That call is not in the history.' });
      return;
    }
    res.status(200).json({
      call: callSummaryView(call, activeCallId(), now()),
      turns: listVoiceTurnsWithSessions(db, call.id).map(turnView),
    });
  });

  router.delete('/voice/calls/:id', (req, res) => {
    const id = req.params.id;
    if (id === activeCallId()) {
      res.status(409).json({ error: 'call_active', message: 'Hang up before deleting this call.' });
      return;
    }
    if (!deleteVoiceCall(db, id)) {
      res.status(404).json({ error: 'call_not_found', message: 'That call is not in the history.' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
