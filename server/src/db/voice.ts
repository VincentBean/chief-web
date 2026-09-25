import { randomUUID } from 'node:crypto';

import {
  changeCount,
  type Database,
  enumeration,
  integer,
  nowIso,
  nullableText,
  real,
  type Row,
  text,
} from './sqlite.js';

/**
 * Voice calls with chief, their transcripts, and the Claude Code conversations
 * the session agents resume.
 *
 * Audio is never stored: a call keeps its transcript text, its timings and its
 * usage counters, and nothing else. Calls are pruned by the scheduler tick
 * (`deleteVoiceCallsEndedBefore`), and a call's turns go with it.
 */

/* -------------------------------------------------------------------- calls */

export const VOICE_END_REASONS = ['hangup', 'idle', 'error', 'taken_over'] as const;
export type VoiceEndReason = (typeof VOICE_END_REASONS)[number];

export interface VoiceCall {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endReason: VoiceEndReason | null;
  readonly sttProvider: string;
  /** The text-to-speech provider used last; it changes on a credit fallback. */
  readonly ttsProvider: string;
  readonly elChars: number;
  readonly sttSeconds: number;
  /** Microphone seconds the browser streamed to Scribe realtime (US-022). */
  readonly scribeSeconds: number;
  readonly orCostUsd: number;
  readonly claudeTurns: number;
}

export interface CreateVoiceCallInput {
  /** Defaults to a fresh UUID; the call socket may already have minted one. */
  readonly id?: string;
  readonly sttProvider: string;
  readonly ttsProvider: string;
  readonly startedAt?: string;
}

export interface UpdateVoiceCallInput {
  readonly endedAt?: string | null;
  readonly endReason?: VoiceEndReason | null;
  readonly sttProvider?: string;
  readonly ttsProvider?: string;
  readonly elChars?: number;
  readonly sttSeconds?: number;
  readonly scribeSeconds?: number;
  readonly orCostUsd?: number;
  readonly claudeTurns?: number;
}

const CALL_COLUMNS: Record<keyof UpdateVoiceCallInput, string> = {
  endedAt: 'ended_at',
  endReason: 'end_reason',
  sttProvider: 'stt_provider',
  ttsProvider: 'tts_provider',
  elChars: 'el_chars',
  sttSeconds: 'stt_seconds',
  scribeSeconds: 'scribe_seconds',
  orCostUsd: 'or_cost_usd',
  claudeTurns: 'claude_turns',
};

function endReasonOf(row: Row): VoiceEndReason | null {
  return nullableText(row, 'end_reason') === null
    ? null
    : enumeration(row, 'end_reason', VOICE_END_REASONS);
}

export function mapVoiceCall(row: Row): VoiceCall {
  return {
    id: text(row, 'id'),
    startedAt: text(row, 'started_at'),
    endedAt: nullableText(row, 'ended_at'),
    endReason: endReasonOf(row),
    sttProvider: text(row, 'stt_provider'),
    ttsProvider: text(row, 'tts_provider'),
    elChars: integer(row, 'el_chars'),
    sttSeconds: real(row, 'stt_seconds'),
    scribeSeconds: real(row, 'scribe_seconds'),
    orCostUsd: real(row, 'or_cost_usd'),
    claudeTurns: integer(row, 'claude_turns'),
  };
}

export function createVoiceCall(db: Database, input: CreateVoiceCallInput): VoiceCall {
  const call: VoiceCall = {
    id: input.id ?? randomUUID(),
    startedAt: input.startedAt ?? nowIso(),
    endedAt: null,
    endReason: null,
    sttProvider: input.sttProvider,
    ttsProvider: input.ttsProvider,
    elChars: 0,
    sttSeconds: 0,
    scribeSeconds: 0,
    orCostUsd: 0,
    claudeTurns: 0,
  };

  db.prepare(
    `INSERT INTO voice_calls
       (id, started_at, ended_at, end_reason, stt_provider, tts_provider, el_chars,
        stt_seconds, or_cost_usd, claude_turns)
     VALUES (?, ?, NULL, NULL, ?, ?, 0, 0, 0, 0)`,
  ).run(call.id, call.startedAt, call.sttProvider, call.ttsProvider);

  return call;
}

export function getVoiceCall(db: Database, id: string): VoiceCall | null {
  const row = db.prepare('SELECT * FROM voice_calls WHERE id = ?').get(id);
  return row ? mapVoiceCall(row) : null;
}

/** Newest first, the order the call history shows them in. */
export function listVoiceCalls(db: Database): VoiceCall[] {
  return db
    .prepare('SELECT * FROM voice_calls ORDER BY started_at DESC, id ASC')
    .all()
    .map(mapVoiceCall);
}

export function updateVoiceCall(
  db: Database,
  id: string,
  input: UpdateVoiceCallInput,
): VoiceCall | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, column] of Object.entries(CALL_COLUMNS)) {
    const value = input[key as keyof UpdateVoiceCallInput];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length === 0) return getVoiceCall(db, id);

  values.push(id);
  const result = db
    .prepare(`UPDATE voice_calls SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values);
  return changeCount(result) === 0 ? null : getVoiceCall(db, id);
}

/** Deletes the call and, by cascade, its turns. */
export function deleteVoiceCall(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM voice_calls WHERE id = ?').run(id)) > 0;
}

/**
 * Closes every call that has no `ended_at`, returning how many.
 *
 * A call lives in the memory of the process that took it, so after a restart
 * an open row is a call nobody is on any more; boot closes them as `error`.
 */
export function closeOpenVoiceCalls(
  db: Database,
  endReason: VoiceEndReason = 'error',
  endedAt: string = nowIso(),
): number {
  return changeCount(
    db
      .prepare('UPDATE voice_calls SET ended_at = ?, end_reason = ? WHERE ended_at IS NULL')
      .run(endedAt, endReason),
  );
}

/**
 * Transcript retention: deletes every call that ended before `cutoff` — or,
 * for a call that was never closed, started before it — together with its
 * turns. Returns how many calls went.
 */
export function deleteVoiceCallsEndedBefore(db: Database, cutoff: string): number {
  return changeCount(
    db.prepare('DELETE FROM voice_calls WHERE COALESCE(ended_at, started_at) < ?').run(cutoff),
  );
}

/* -------------------------------------------------------------------- turns */

export const VOICE_SPEAKERS = ['user', 'chief', 'session', 'event'] as const;
export type VoiceSpeaker = (typeof VOICE_SPEAKERS)[number];

export interface VoiceTurn {
  readonly id: number;
  readonly callId: string;
  readonly turn: number;
  readonly speaker: VoiceSpeaker;
  /** The session in focus at the time; `null` while talking to chief. */
  readonly sessionId: string | null;
  readonly text: string;
  readonly interrupted: boolean;
  /** `[{name, status, summary}]` as JSON, when the turn called tools. */
  readonly toolsJson: string | null;
  readonly tSpeechEnd: string | null;
  readonly tTranscript: string | null;
  readonly tFirstToken: string | null;
  readonly tFirstChunk: string | null;
  readonly tFirstAudioSent: string | null;
  readonly tFirstAudioPlayed: string | null;
  readonly createdAt: string;
}

export interface InsertVoiceTurnInput {
  readonly callId: string;
  readonly turn: number;
  readonly speaker: VoiceSpeaker;
  readonly sessionId?: string | null;
  readonly text: string;
  readonly interrupted?: boolean;
  readonly toolsJson?: string | null;
  readonly tSpeechEnd?: string | null;
  readonly tTranscript?: string | null;
  readonly tFirstToken?: string | null;
  readonly tFirstChunk?: string | null;
  readonly tFirstAudioSent?: string | null;
  readonly tFirstAudioPlayed?: string | null;
}

export interface UpdateVoiceTurnInput {
  readonly sessionId?: string | null;
  readonly text?: string;
  readonly interrupted?: boolean;
  readonly toolsJson?: string | null;
  readonly tSpeechEnd?: string | null;
  readonly tTranscript?: string | null;
  readonly tFirstToken?: string | null;
  readonly tFirstChunk?: string | null;
  readonly tFirstAudioSent?: string | null;
  readonly tFirstAudioPlayed?: string | null;
}

const TURN_COLUMNS: Record<keyof UpdateVoiceTurnInput, string> = {
  sessionId: 'session_id',
  text: 'text',
  interrupted: 'interrupted',
  toolsJson: 'tools_json',
  tSpeechEnd: 't_speech_end',
  tTranscript: 't_transcript',
  tFirstToken: 't_first_token',
  tFirstChunk: 't_first_chunk',
  tFirstAudioSent: 't_first_audio_sent',
  tFirstAudioPlayed: 't_first_audio_played',
};

export function mapVoiceTurn(row: Row): VoiceTurn {
  return {
    id: integer(row, 'id'),
    callId: text(row, 'call_id'),
    turn: integer(row, 'turn'),
    speaker: enumeration(row, 'speaker', VOICE_SPEAKERS),
    sessionId: nullableText(row, 'session_id'),
    text: text(row, 'text'),
    interrupted: integer(row, 'interrupted') !== 0,
    toolsJson: nullableText(row, 'tools_json'),
    tSpeechEnd: nullableText(row, 't_speech_end'),
    tTranscript: nullableText(row, 't_transcript'),
    tFirstToken: nullableText(row, 't_first_token'),
    tFirstChunk: nullableText(row, 't_first_chunk'),
    tFirstAudioSent: nullableText(row, 't_first_audio_sent'),
    tFirstAudioPlayed: nullableText(row, 't_first_audio_played'),
    createdAt: text(row, 'created_at'),
  };
}

export function insertVoiceTurn(db: Database, input: InsertVoiceTurnInput): VoiceTurn {
  const result = db
    .prepare(
      `INSERT INTO voice_turns
         (call_id, turn, speaker, session_id, text, interrupted, tools_json, t_speech_end,
          t_transcript, t_first_token, t_first_chunk, t_first_audio_sent,
          t_first_audio_played, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.callId,
      input.turn,
      input.speaker,
      input.sessionId ?? null,
      input.text,
      input.interrupted === true ? 1 : 0,
      input.toolsJson ?? null,
      input.tSpeechEnd ?? null,
      input.tTranscript ?? null,
      input.tFirstToken ?? null,
      input.tFirstChunk ?? null,
      input.tFirstAudioSent ?? null,
      input.tFirstAudioPlayed ?? null,
      nowIso(),
    );

  const inserted = getVoiceTurn(db, Number(result.lastInsertRowid));
  if (inserted === null) throw new Error('The voice turn disappeared immediately after insertion.');
  return inserted;
}

export function getVoiceTurn(db: Database, id: number): VoiceTurn | null {
  const row = db.prepare('SELECT * FROM voice_turns WHERE id = ?').get(id);
  return row ? mapVoiceTurn(row) : null;
}

/** A call's transcript, in the order it was spoken. */
export function listVoiceTurns(db: Database, callId: string): VoiceTurn[] {
  return db
    .prepare('SELECT * FROM voice_turns WHERE call_id = ? ORDER BY turn ASC, id ASC')
    .all(callId)
    .map(mapVoiceTurn);
}

export function updateVoiceTurn(
  db: Database,
  id: number,
  input: UpdateVoiceTurnInput,
): VoiceTurn | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, column] of Object.entries(TURN_COLUMNS)) {
    const value = input[key as keyof UpdateVoiceTurnInput];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (assignments.length === 0) return getVoiceTurn(db, id);

  values.push(id);
  const result = db
    .prepare(`UPDATE voice_turns SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values);
  return changeCount(result) === 0 ? null : getVoiceTurn(db, id);
}

export function deleteVoiceTurn(db: Database, id: number): boolean {
  return changeCount(db.prepare('DELETE FROM voice_turns WHERE id = ?').run(id)) > 0;
}

/* ----------------------------------------------------------- session agents */

export const VOICE_AGENT_MODES = ['plan', 'qa'] as const;
export type VoiceAgentMode = (typeof VOICE_AGENT_MODES)[number];

/** The Claude Code conversation a session's voice agent resumes with `--resume`. */
export interface VoiceSessionAgent {
  readonly sessionId: string;
  readonly claudeSessionId: string;
  readonly mode: VoiceAgentMode;
  readonly updatedAt: string;
}

export interface UpsertVoiceSessionAgentInput {
  readonly sessionId: string;
  readonly claudeSessionId: string;
  readonly mode: VoiceAgentMode;
}

export function mapVoiceSessionAgent(row: Row): VoiceSessionAgent {
  return {
    sessionId: text(row, 'session_id'),
    claudeSessionId: text(row, 'claude_session_id'),
    mode: enumeration(row, 'mode', VOICE_AGENT_MODES),
    updatedAt: text(row, 'updated_at'),
  };
}

/** Records the conversation a session's agent is on, replacing any earlier one. */
export function upsertVoiceSessionAgent(
  db: Database,
  input: UpsertVoiceSessionAgentInput,
): VoiceSessionAgent {
  const agent: VoiceSessionAgent = { ...input, updatedAt: nowIso() };
  db.prepare(
    `INSERT INTO voice_session_agents (session_id, claude_session_id, mode, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       claude_session_id = excluded.claude_session_id,
       mode = excluded.mode,
       updated_at = excluded.updated_at`,
  ).run(agent.sessionId, agent.claudeSessionId, agent.mode, agent.updatedAt);
  return agent;
}

export function getVoiceSessionAgent(db: Database, sessionId: string): VoiceSessionAgent | null {
  const row = db
    .prepare('SELECT * FROM voice_session_agents WHERE session_id = ?')
    .get(sessionId);
  return row ? mapVoiceSessionAgent(row) : null;
}

export function listVoiceSessionAgents(db: Database): VoiceSessionAgent[] {
  return db
    .prepare('SELECT * FROM voice_session_agents ORDER BY updated_at DESC')
    .all()
    .map(mapVoiceSessionAgent);
}

export function deleteVoiceSessionAgent(db: Database, sessionId: string): boolean {
  return (
    changeCount(
      db.prepare('DELETE FROM voice_session_agents WHERE session_id = ?').run(sessionId),
    ) > 0
  );
}
