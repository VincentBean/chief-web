import type { ReactNode } from 'react';

import type { Session, Story } from './api.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Link } from './router.tsx';

/**
 * The small vocabulary every page is built from. Kept as plain components over
 * the BEM classes in `styles/` so a page never has to know a class name for a
 * badge or a progress bar, and so every page's badge is the same badge.
 */

export type Tone = 'neutral' | 'ready' | 'active' | 'wait' | 'done' | 'review' | 'final' | 'danger';

/**
 * Every state string the app produces maps to exactly one tone, so a session,
 * a story and a log connection that mean the same thing look the same.
 */
export const SESSION_TONE: Record<Session['status'], Tone> = {
  pending: 'neutral',
  ready: 'ready',
  building: 'active',
  waiting: 'wait',
  failed: 'danger',
  // The purple pair is the pull request lifecycle; a session that ended with
  // no pull request is done green, because nothing about it is still moving.
  finished: 'done',
  // The draft chain: the review reads (purple, like the pull request it is
  // about), the feedback run writes (green-blue `active`, like a build).
  reviewing: 'review',
  fixing: 'active',
  'pr-open': 'review',
  merged: 'final',
};

export const STORY_TONE: Record<Story['status'], Tone> = {
  todo: 'neutral',
  'in-progress': 'active',
  done: 'done',
};

/** What the operator reads for each state. */
export const SESSION_LABEL: Record<Session['status'], string> = {
  pending: 'planning',
  ready: 'ready',
  building: 'building',
  waiting: 'on hold',
  failed: 'failed',
  finished: 'finished',
  reviewing: 'reviewing',
  fixing: 'fixing feedback',
  'pr-open': 'pr open',
  merged: 'merged',
};

/** Statuses with an agent of their own running: worth a moving dot. */
function isRunning(status: Session['status']): boolean {
  return status === 'building' || status === 'reviewing' || status === 'fixing';
}

export function Badge({
  tone = 'neutral',
  pulse = false,
  children,
  title,
}: {
  readonly tone?: Tone;
  /** A moving dot: the one cue that says "running right now". */
  readonly pulse?: boolean;
  readonly children: ReactNode;
  readonly title?: string;
}) {
  return (
    <span className={`badge badge--${tone}${pulse ? ' badge--pulse' : ''}`} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ session }: { readonly session: Pick<Session, 'status' | 'prUrl'> }) {
  // Once a session is about its pull request, the badge is also the way to it:
  // the state and the thing in that state are the same click.
  const pr = session.status === 'pr-open' || session.status === 'merged' ? session.prUrl : null;
  const badge = (
    <Badge tone={SESSION_TONE[session.status]} pulse={isRunning(session.status)}>
      {SESSION_LABEL[session.status]}
      {pr !== null && <Icon name="link-external" />}
    </Badge>
  );
  if (pr === null) return badge;
  return (
    <a
      className="badge-link"
      href={pr}
      target="_blank"
      rel="noreferrer"
      title={session.status === 'merged' ? 'Open the merged pull request on GitHub' : 'Open the pull request on GitHub'}
    >
      {badge}
    </a>
  );
}

/** A coloured dot on its own, for dense rows where a pill is too loud. */
export function StatusDot({ status }: { readonly status: Session['status'] }) {
  return (
    <span
      className={`dot dot--${SESSION_TONE[status]}${isRunning(status) ? ' dot--pulse' : ''}`}
      title={SESSION_LABEL[status]}
      aria-label={SESSION_LABEL[status]}
      role="img"
    />
  );
}

const NOTICE_ICON: Record<'ok' | 'error' | 'warn' | 'info', IconName> = {
  ok: 'check-circle',
  error: 'x-circle',
  warn: 'alert',
  info: 'info',
};

export function Notice({
  kind,
  children,
  role,
  className,
}: {
  readonly kind: 'ok' | 'error' | 'warn' | 'info';
  readonly children: ReactNode;
  readonly role?: 'alert' | 'status';
  readonly className?: string;
}) {
  return (
    <div
      className={`notice notice--${kind}${className === undefined ? '' : ` ${className}`}`}
      role={role ?? (kind === 'error' ? 'alert' : 'status')}
    >
      <Icon name={NOTICE_ICON[kind]} />
      <div className="notice__body">{children}</div>
    </div>
  );
}

/** Story progress as a bar, with the fraction beside it. */
export function Progress({
  done,
  total,
  tone = 'active',
  compact = false,
  label,
}: {
  readonly done: number;
  readonly total: number;
  readonly tone?: Tone;
  readonly compact?: boolean;
  readonly label?: string;
}) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className={`progress${compact ? ' progress--compact' : ''}`}>
      <div
        className={`progress__track progress__track--${tone}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={label ?? 'Stories done'}
      >
        <div className="progress__fill" style={{ width: `${String(percent)}%` }} />
      </div>
      <span className="progress__label mono">
        {total === 0 ? '—' : `${String(done)}/${String(total)}`}
      </span>
    </div>
  );
}

/** Build slots as one cell per slot. */
export function Meter({
  value,
  max,
  label,
}: {
  readonly value: number;
  readonly max: number;
  readonly label: string;
}) {
  const cells = Math.max(1, Math.min(max, 12));
  return (
    <div className="meter" role="img" aria-label={label}>
      {Array.from({ length: cells }, (_, index) => (
        <span
          className={`meter__cell${index < Math.min(value, cells) ? ' meter__cell--on' : ''}`}
          key={index}
        />
      ))}
      {max > cells && <span className="meter__more">+{max - cells}</span>}
    </div>
  );
}

/** A number the overview reports, with what it is. */
export function Figure({
  label,
  value,
  hint,
  tone,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: Tone;
}) {
  return (
    <div className={`figure${tone === undefined ? '' : ` figure--${tone}`}`}>
      <span className="figure__value">{value}</span>
      <span className="figure__label">{label}</span>
      {hint !== undefined && <span className="figure__hint">{hint}</span>}
    </div>
  );
}

/**
 * A bar per day. Inline SVG rather than a chart library: one series, no axes
 * to speak of, and the number that matters is written next to it.
 */
export function Bars({
  values,
  labels,
  ariaLabel,
}: {
  readonly values: readonly number[];
  readonly labels: readonly string[];
  readonly ariaLabel: string;
}) {
  const max = Math.max(1, ...values);
  const width = 100;
  const height = 36;
  const gap = 1.5;
  const bar = (width - gap * (values.length - 1)) / Math.max(1, values.length);
  return (
    <svg
      className="bars"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      {values.map((value, index) => {
        const h = value === 0 ? 1 : Math.max(2, (value / max) * height);
        return (
          <rect
            key={labels[index] ?? index}
            className={value === 0 ? 'bars__bar bars__bar--empty' : 'bars__bar'}
            x={index * (bar + gap)}
            y={height - h}
            width={bar}
            height={h}
            rx={0.6}
          >
            <title>{`${labels[index] ?? ''}: ${String(value)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} className="icon--lg" />
      </span>
      <h3 className="empty__title">{title}</h3>
      {children !== undefined && <div className="empty__body">{children}</div>}
      {action !== undefined && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  actions,
  back,
}: {
  readonly title: ReactNode;
  /** A line above the title: a repository name, or a section. */
  readonly eyebrow?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly back?: { readonly href: string; readonly label: string };
}) {
  return (
    <header className="page__header">
      <div className="page__heading">
        {back !== undefined && (
          <Link className="page__back" href={back.href}>
            <Icon name="arrow-left" />
            {back.label}
          </Link>
        )}
        {eyebrow !== undefined && <div className="page__eyebrow">{eyebrow}</div>}
        <h1 className="page__title">{title}</h1>
        {subtitle !== undefined && <p className="page__subtitle">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="page__actions">{actions}</div>}
    </header>
  );
}

/** A titled surface. The product's one container shape. */
export function Panel({
  title,
  icon,
  meta,
  actions,
  children,
  tone,
  className,
  id,
}: {
  readonly title?: ReactNode;
  readonly icon?: IconName;
  /** Sits beside the title: a badge, a count. */
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly tone?: 'danger' | 'warn';
  readonly className?: string;
  readonly id?: string;
}) {
  const classes = ['panel'];
  if (tone !== undefined) classes.push(`panel--${tone}`);
  if (className !== undefined) classes.push(className);
  return (
    <section className={classes.join(' ')} id={id}>
      {(title !== undefined || actions !== undefined) && (
        <header className="panel__header">
          <h2 className="panel__title">
            {icon !== undefined && <Icon name={icon} />}
            {title}
            {meta}
          </h2>
          {actions !== undefined && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  );
}

/** Label / value pairs. */
export function Facts({
  items,
}: {
  readonly items: readonly { readonly label: string; readonly value: ReactNode; readonly mono?: boolean }[];
}) {
  return (
    <dl className="facts">
      {items.map((item) => (
        <div className="facts__row" key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.mono === true ? 'mono' : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kbd({ children }: { readonly children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Skeleton({ lines = 3 }: { readonly lines?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span className="skeleton__line" key={index} style={{ width: `${String(90 - (index % 3) * 18)}%` }} />
      ))}
    </div>
  );
}

/** Content that should be read but not shown. */
export function VisuallyHidden({ children }: { readonly children: ReactNode }) {
  return <span className="visually-hidden">{children}</span>;
}

/** A row of segmented choices; the product's filter control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: ReactNode; readonly count?: number }[];
  readonly onChange: (value: T) => void;
  readonly ariaLabel: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={`segmented__option${option.value === value ? ' segmented__option--active' : ''}`}
          key={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className="segmented__count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}
