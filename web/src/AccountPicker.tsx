import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  type ClaudeAccountStatus,
  type ClaudeUsage,
  type ClaudeUsageWindow,
  claudeAccountName,
  claudeNeedsSignIn,
} from './api.ts';
import { useAppData } from './data.tsx';
import { Icon } from './Icon.tsx';
import { Badge, claudeUsageTone, Gauge } from './ui.tsx';

/**
 * Picks the Claude account something runs on (multiple accounts US-010).
 *
 * A custom listbox rather than a `<select>`: the point of choosing is the
 * headroom each account has left, and a native option can only hold text.
 * The numbers come from the app-wide 5-second stats poll, so every picker on
 * every page shows the same live usage as the sidebar; `accounts` supplies
 * who each account is and whether it is signed in.
 *
 * `null` means "whatever the default is at launch time", which is not the
 * same as the default's id: the session follows the setting if it changes.
 */
export interface AccountPickerProps {
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly accounts: readonly ClaudeAccountStatus[];
  readonly defaultAccountId: string | null;
  readonly disabled?: boolean;
  /** The trigger's id, for the `<label htmlFor>` that names it. */
  readonly id: string;
}

/** The gap kept between a clamped popover and the viewport's edges. */
const GUTTER_PX = 16;
/** Wide enough for a name and both bars on one line each. */
const MIN_POPOVER_PX = 320;
const GAP_PX = 4;

interface Live {
  readonly usage: ClaudeUsage | null;
  readonly held: boolean;
}

interface Choice {
  readonly value: string | null;
  /** The account the choice runs on: the default's for the "Default" choice. */
  readonly account: ClaudeAccountStatus | null;
  readonly label: string;
  readonly isDefault: boolean;
  readonly disabled: boolean;
}

export function AccountPicker({ value, onChange, accounts, defaultAccountId, disabled = false, id }: AccountPickerProps) {
  const { stats, claude } = useAppData();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const now = Date.now();
  const live = (account: ClaudeAccountStatus): Live => {
    const entry = stats?.accounts.find((candidate) => candidate.id === account.id);
    const holdUntil = entry?.holdUntil ?? null;
    return {
      usage: entry?.usage ?? account.usage,
      held: holdUntil !== null && new Date(holdUntil).getTime() > now,
    };
  };

  const defaultAccount = accounts.find((account) => account.id === defaultAccountId) ?? null;
  // An implicit default is whichever account is signed in first at launch
  // time, so naming today's pick would promise something it may not keep.
  const defaultLabel =
    defaultAccount === null || claude?.defaultIsExplicit === false
      ? 'Default (first signed-in account)'
      : `Default (${claudeAccountName(defaultAccount)})`;
  const choices: readonly Choice[] = [
    {
      value: null,
      account: defaultAccount,
      label: defaultLabel,
      isDefault: false,
      disabled: false,
    },
    ...accounts.map((account) => ({
      value: account.id,
      account,
      label: claudeAccountName(account),
      isDefault: account.id === defaultAccountId,
      // A held account stays choosable: failover moves the session on.
      disabled: !account.authenticated,
    })),
  ];
  const selectedIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === value),
  );
  const selected: Choice = choices[selectedIndex]?.value === value
    ? choices[selectedIndex]
    : // An account removed since the value was saved.
      { value, account: null, label: `Account ${(value ?? '').slice(0, 8)}`, isDefault: false, disabled: true };

  const listboxId = `${id}-listbox`;
  const optionId = (index: number): string => `${id}-option-${String(index)}`;

  const close = useCallback((refocus: boolean): void => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openAt = (index: number): void => {
    if (disabled) return;
    // Inside a modal `<dialog>` everything outside the top layer is inert, so
    // the popover has to live in the dialog to be clickable.
    setPortalTarget(triggerRef.current?.closest('dialog') ?? document.body);
    setActive(index);
    setOpen(true);
  };

  const choose = (index: number): void => {
    const choice = choices[index];
    if (choice === undefined || choice.disabled) return;
    if (choice.value !== value) onChange(choice.value);
    close(true);
  };

  /*
   * Fixed to the viewport so no panel's `overflow` clips it, below the
   * trigger unless there is more room above, at least as wide as the trigger
   * and never wider than the viewport less a gutter on each side — on a
   * phone that is what keeps the right-hand percentages on screen.
   */
  const place = useCallback((): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(rect.width, MIN_POPOVER_PX), viewportWidth - 2 * GUTTER_PX);
    const left = Math.min(Math.max(rect.left, GUTTER_PX), viewportWidth - GUTTER_PX - width);
    const below = viewportHeight - rect.bottom - GAP_PX - GUTTER_PX;
    const above = rect.top - GAP_PX - GUTTER_PX;
    const listHeight = listRef.current?.scrollHeight ?? 0;
    setPosition(
      below >= listHeight || below >= above
        ? { left, width, top: rect.bottom + GAP_PX, maxHeight: below }
        : { left, width, bottom: viewportHeight - rect.top + GAP_PX, maxHeight: above },
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }
    place();
    const onMove = (): void => {
      place();
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place]);

  // Focus moves in only once the popover is placed: until then it is
  // `visibility: hidden`, and a hidden element refuses focus.
  const placed = position !== null;
  useEffect(() => {
    if (open && placed) listRef.current?.focus({ preventScroll: true });
  }, [open, placed]);

  // A press anywhere else closes it without stealing focus from what was pressed.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) === true || listRef.current?.contains(target) === true) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${String(active)}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(selectedIndex);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const last = choices.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((index) => Math.min(last, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(last);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        break;
      case 'Escape':
        // Also keeps a surrounding modal `<dialog>` from closing.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // Back onto the trigger before the browser moves focus, so Tab and
        // Shift+Tab leave from where the picker sits in the form rather than
        // from the end of the document the popover is portalled into.
        triggerRef.current?.focus();
        setOpen(false);
        break;
      default:
    }
  };

    return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="field__input account-picker"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-describedby={`${id}-value`}
        onClick={() => {
          if (open) close(false);
          else openAt(selectedIndex);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="account-picker__value" id={`${id}-value`}>
          <ChoiceSummary choice={selected} live={selected.account === null ? null : live(selected.account)} />
        </span>
        <Icon name="chevron-down" className="account-picker__chevron" />
      </button>
      {open &&
        portalTarget !== null &&
        createPortal(
          <ul
            ref={listRef}
            id={listboxId}
            className="account-picker__popover"
            role="listbox"
            aria-label="Claude account"
            aria-activedescendant={optionId(active)}
            tabIndex={-1}
            style={position ?? { visibility: 'hidden' }}
            onKeyDown={onListKeyDown}
          >
            {choices.map((choice, index) => (
              <li
                key={choice.value ?? ''}
                id={optionId(index)}
                role="option"
                aria-selected={index === selectedIndex}
                aria-disabled={choice.disabled || undefined}
                className={`account-picker__option${index === active ? ' account-picker__option--active' : ''}`}
                onPointerMove={() => {
                  if (index !== active) setActive(index);
                }}
                onClick={() => {
                  choose(index);
                }}
              >
                <ChoiceSummary choice={choice} live={choice.account === null ? null : live(choice.account)} detailed />
                {index === selectedIndex && <Icon name="check" className="account-picker__check" />}
              </li>
            ))}
          </ul>,
          portalTarget,
        )}
    </>
  );
}

/**
 * One choice's face: dot, name, badge and the two bars. `detailed` adds what
 * only the open list has room for — the email under a nickname and the
 * "(default)" marker.
 */
function ChoiceSummary({
  choice,
  live,
  detailed = false,
}: {
  readonly choice: Choice;
  readonly live: Live | null;
  readonly detailed?: boolean;
}) {
  const { account } = choice;
  const signedOut = account !== null && !account.authenticated;
  const signInAgain = !signedOut && claudeNeedsSignIn(live?.usage);
  const held = !signedOut && !signInAgain && live?.held === true;
  const dot =
    account === null ? 'dot--neutral' : signedOut || signInAgain ? 'dot--danger' : held ? 'dot--wait' : 'dot--done';
  const name = choice.label;

  return (
    <span className="account-picker__choice">
      <span className={`dot ${dot}`} />
      <span className="account-picker__name">
        <span className="account-picker__label">{name}</span>
        {detailed && choice.isDefault && <span className="account-picker__muted"> (default)</span>}
        {detailed && choice.value !== null && account?.nickname != null && account.email !== null && (
          <span className="account-picker__muted account-picker__email">{account.email}</span>
        )}
      </span>
      {signedOut ? (
        <Badge tone="danger">not signed in</Badge>
      ) : signInAgain ? (
        <Badge tone="danger">sign in again</Badge>
      ) : held ? (
        <Badge tone="wait">on hold</Badge>
      ) : null}
      <span className="account-picker__usage">
        <UsageBar label="5h" name={name} window={live?.usage?.fiveHour ?? null} />
        <UsageBar label="7d" name={name} window={live?.usage?.sevenDay ?? null} />
      </span>
    </span>
  );
}

function UsageBar({
  label,
  name,
  window,
}: {
  readonly label: string;
  readonly name: string;
  readonly window: ClaudeUsageWindow | null;
}) {
  return (
    <span className="account-picker__window">
      <span className="account-picker__muted">{label}</span>
      {window === null ? (
        <span className="account-picker__percent">–</span>
      ) : (
        <>
          <Gauge
            value={window.utilization / 100}
            label={`${name} ${label} usage`}
            tone={claudeUsageTone(window.utilization)}
          />
          <span className="account-picker__percent">{`${String(Math.round(window.utilization))}%`}</span>
        </>
      )}
    </span>
  );
}
