import { useEffect, useState } from 'react';

import { fetchPrd, type SessionPrd, type SessionPrdStory } from '../api.ts';

/**
 * The plan of the session a call is focused on (calling-interface US-005):
 * the PRD's title, every story in priority order with its acceptance criteria,
 * and the open questions. It is loaded when it mounts (CallPanel keys it on the
 * session) and again whenever the session's planning `state` or `stories`
 * count changes; unmounting or reloading aborts the request in flight. A
 * failed load only says so here, the transcript below it keeps working.
 */

type PlanLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly prd: SessionPrd }
  | { readonly kind: 'failed'; readonly message: string };

const STORY_STATUS: Record<SessionPrdStory['status'], string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done',
};

export function CallPlan({
  sessionId,
  name,
  state,
  stories,
}: {
  readonly sessionId: string;
  /** The session's name, shown while there is no PRD yet. */
  readonly name: string;
  /** The session's planning state and story count in `call.planning`, when it is there. */
  readonly state: string | undefined;
  readonly stories: number | undefined;
}) {
  const [load, setLoad] = useState<PlanLoad>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchPrd(sessionId, controller.signal).then(
      (prd) => {
        if (!controller.signal.aborted) setLoad({ kind: 'loaded', prd });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [sessionId, state, stories]);

  return (
    <section className="call-plan" aria-label="Plan">
      <PlanBody load={load} name={name} />
    </section>
  );
}

function PlanBody({ load, name }: { readonly load: PlanLoad; readonly name: string }) {
  if (load.kind === 'loading') return <p className="call-plan__note">Loading the plan…</p>;
  if (load.kind === 'failed') {
    return (
      <p className="call-plan__note call-plan__note--error" role="alert">
        Could not load the plan: {load.message}
      </p>
    );
  }

  const { prd } = load;
  if (!prd.status.exists) {
    return (
      <>
        <h2 className="call-plan__title">{name}</h2>
        <p className="call-plan__note">The plan appears here once it has been written.</p>
      </>
    );
  }

  const firstError = prd.status.errors[0];
  const stories = [...prd.stories].sort((a, b) => a.priority - b.priority);
  return (
    <>
      <h2 className="call-plan__title">{prd.project ?? name}</h2>
      {!prd.status.parses && (
        <p className="call-plan__note call-plan__note--error">
          The PRD does not parse
          {firstError !== undefined && `: line ${String(firstError.line)}, ${firstError.message}`}
        </p>
      )}
      {stories.length > 0 && (
        <ol className="call-plan__stories">
          {stories.map((story) => (
            <li key={story.id} className="call-plan__story">
              <div className="call-plan__story-head">
                <span className="call-plan__story-id">{story.id}</span>
                <h3 className="call-plan__story-title">{story.title}</h3>
                <span className={`call-plan__status call-plan__status--${story.status}`}>{STORY_STATUS[story.status]}</span>
              </div>
              {story.description !== '' && <p className="call-plan__story-description">{story.description}</p>}
              {story.acceptanceCriteria.length > 0 && (
                <ul className="call-plan__criteria">
                  {story.acceptanceCriteria.map((criterion, index) => (
                    <li key={index}>
                      <label>
                        <input type="checkbox" checked={criterion.checked} readOnly disabled />
                        <span>{criterion.text}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      {prd.openQuestions.length > 0 && (
        <>
          <h3 className="call-plan__heading">Open questions</h3>
          <ul className="call-plan__questions">
            {prd.openQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
