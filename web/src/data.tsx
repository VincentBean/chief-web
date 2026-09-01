import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  ApiError,
  type ClaudeState,
  fetchClaudeState,
  fetchRepositories,
  fetchSessions,
  fetchStats,
  type Repository,
  type Session,
  type Stats,
} from './api.ts';

/**
 * The app-wide data every authenticated page reads.
 *
 * Sessions are moved along by the build loop, the scheduler and the planning
 * terminal — all in other processes, none able to reach this tab — so the only
 * way to show a change is to keep looking. One poll here feeds the sidebar's
 * counts, the overview and the session list at once, rather than each page
 * running its own. A hidden tab polls nothing; coming back re-reads at once.
 */

const SESSIONS_POLL_MS = 3000;
const STATS_POLL_MS = 5000;

export interface AppData {
  readonly sessions: Session[] | null;
  readonly repositories: Repository[] | null;
  readonly stats: Stats | null;
  readonly claude: ClaudeState | null;
  /** The last failure to read the list; the previous data stays on screen. */
  readonly error: string | null;
  /** Re-reads sessions and stats now, after an action changed something. */
  readonly refresh: () => Promise<void>;
  /** Replaces the cached Claude status, e.g. after a login. */
  readonly setClaude: (state: ClaudeState) => void;
}

const Context = createContext<AppData | null>(null);

export function describeError(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error);
}

/** `401` on any read means the cookie expired: back to the login page. */
export function redirectIfUnauthorised(error: unknown): boolean {
  if (error instanceof ApiError && error.status === 401) {
    window.location.replace('/login');
    return true;
  }
  return false;
}

export function AppDataProvider({ children }: { readonly children: ReactNode }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [claude, setClaude] = useState<ClaudeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The signal of the read in flight, so a poll never stacks behind a slow
   * one. Keyed on the signal rather than a boolean: StrictMode aborts the
   * first mount's read and starts the second's before the abort has settled,
   * and a boolean would make the second one wait for the next poll.
   */
  const inFlight = useRef<AbortSignal | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (inFlight.current !== null && !inFlight.current.aborted) return;
    inFlight.current = signal ?? new AbortController().signal;
    try {
      const [loadedSessions, loadedRepositories] = await Promise.all([
        fetchSessions(signal),
        fetchRepositories(signal),
      ]);
      setSessions(loadedSessions);
      setRepositories(loadedRepositories);
      setError(null);
    } catch (cause: unknown) {
      if (signal?.aborted === true) return;
      if (redirectIfUnauthorised(cause)) return;
      setError(describeError(cause));
    } finally {
      inFlight.current = null;
    }
  }, []);

  const loadStats = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      setStats(await fetchStats(signal));
    } catch (cause: unknown) {
      if (signal?.aborted === true) return;
      redirectIfUnauthorised(cause);
      // The overview says so itself; the shell keeps the last numbers.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const visible = (): boolean => document.visibilityState === 'visible';

    void load(controller.signal);
    void loadStats(controller.signal);
    const sessionsTimer = window.setInterval(() => {
      if (visible()) void load(controller.signal);
    }, SESSIONS_POLL_MS);
    const statsTimer = window.setInterval(() => {
      if (visible()) void loadStats(controller.signal);
    }, STATS_POLL_MS);
    const onVisible = (): void => {
      if (!visible()) return;
      void load(controller.signal);
      void loadStats(controller.signal);
    };
    document.addEventListener('visibilitychange', onVisible);

    // Sessions need a signed-in Claude Code (US-008). Checked once: a probe
    // costs a container start, so it is not polled.
    fetchClaudeState({ signal: controller.signal })
      .then(setClaude)
      .catch(() => {
        // The settings page reports why; the shell stays quiet.
      });

    return () => {
      controller.abort();
      window.clearInterval(sessionsTimer);
      window.clearInterval(statsTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, loadStats]);

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([load(), loadStats()]);
  }, [load, loadStats]);

  const value = useMemo<AppData>(
    () => ({ sessions, repositories, stats, claude, error, refresh, setClaude }),
    [sessions, repositories, stats, claude, error, refresh],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAppData(): AppData {
  const value = useContext(Context);
  if (value === null) throw new Error('useAppData() outside <AppDataProvider>');
  return value;
}

/** A session that needs the operator: failed, held, or slept through its start. */
export function needsAttention(session: Session): boolean {
  return session.status === 'failed' || session.status === 'waiting' || session.scheduleMissed;
}

/** A session with a build slot, or waiting for one. */
export function isActive(session: Session): boolean {
  return (
    session.status === 'building' || session.status === 'waiting' || session.queuePosition !== null
  );
}

/** Keyboard shortcuts: a leader key (`g`) followed by a letter within a second. */
export function useKeyChords(bindings: Record<string, () => void>): void {
  const ref = useRef(bindings);
  ref.current = bindings;
  useEffect(() => {
    let leader = 0;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable ||
          target.closest('.xterm') !== null);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      const now = Date.now();
      const key = event.key.toLowerCase();
      if (leader !== 0 && now - leader < 1000) {
        leader = 0;
        const action = ref.current[`g ${key}`];
        if (action !== undefined) {
          event.preventDefault();
          action();
        }
        return;
      }
      if (key === 'g') {
        leader = now;
        return;
      }
      const action = ref.current[key];
      if (action !== undefined) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}
