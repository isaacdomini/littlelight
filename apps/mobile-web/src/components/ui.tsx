import { IonIcon } from "@ionic/react";
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from "react";
import { t } from "../i18n";

// Form and layout primitives for the design system (docs/DESIGN.md). Native elements keep
// `data-testid` + Playwright `fill`/`check` working inside Capacitor too; the look comes from
// styles.css (`.ll-*` classes and the base layer that styles every native control).

interface FieldShellProps {
  label: string;
  hint?: string;
  /** Visually hide the label (still read by screen readers). */
  hideLabel?: boolean;
}

function Hint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="ll-hint">
      {children}
    </p>
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement>, FieldShellProps {}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, hideLabel, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={inputId} className={hideLabel ? "sr-only" : "ll-label"}>
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        className={className}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        {...rest}
      />
      {hint ? <Hint id={`${inputId}-hint`}>{hint}</Hint> : null}
    </div>
  );
});

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldShellProps {}

/** Label + styled native select (chevron, 44 px, focus ring). */
export function SelectField({
  label,
  hint,
  hideLabel,
  className,
  id,
  children,
  ...rest
}: SelectFieldProps) {
  const auto = useId();
  const selectId = id ?? auto;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={selectId} className={hideLabel ? "sr-only" : "ll-label"}>
        {label}
      </label>
      <select
        id={selectId}
        className={className}
        aria-describedby={hint ? `${selectId}-hint` : undefined}
        {...rest}
      >
        {children}
      </select>
      {hint ? <Hint id={`${selectId}-hint`}>{hint}</Hint> : null}
    </div>
  );
}

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldShellProps {
  /** Right-aligned caption under the box, e.g. a character counter. */
  counter?: string;
}

export function TextAreaField({
  label,
  hint,
  hideLabel,
  counter,
  className,
  id,
  ...rest
}: TextAreaFieldProps) {
  const auto = useId();
  const areaId = id ?? auto;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={areaId} className={hideLabel ? "sr-only" : "ll-label"}>
        {label}
      </label>
      <textarea
        id={areaId}
        className={className}
        aria-describedby={hint ? `${areaId}-hint` : undefined}
        {...rest}
      />
      {hint ? <Hint id={`${areaId}-hint`}>{hint}</Hint> : null}
      {counter ? <p className="ll-caption text-right">{counter}</p> : null}
    </div>
  );
}

export function CheckField({
  label,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }) {
  return (
    <label className="ll-check">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * primary = filled accent (one per screen); secondary = quiet fill; danger = danger text
   * (confirm first); link = accent text only.
   */
  variant?: "primary" | "secondary" | "danger" | "link";
  size?: "md" | "sm";
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`ll-btn ll-btn-${variant}${size === "sm" ? " ll-btn-sm" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}

/** Error / info text announced to screen readers. */
export function Message({
  kind = "error",
  children,
  ...rest
}: { kind?: "error" | "info"; children: ReactNode } & { "data-testid"?: string }) {
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={kind === "error" ? "ll-msg-error" : "ll-msg-info"}
      {...rest}
    >
      {children}
    </p>
  );
}

export function Card({
  children,
  className,
  tone,
  ...rest
}: HTMLAttributes<HTMLElement> & { tone?: "danger" }) {
  return (
    <section
      className={`ll-card${tone === "danger" ? " ll-card-danger" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </section>
  );
}

/** Pill with a label (read-only tag). */
export function Tag({ children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="ll-tag" {...rest}>
      {children}
    </span>
  );
}

/** Segmented tabs; children are `<button role="tab" aria-selected>`. */
export function Segmented({
  label,
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={`ll-seg${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

/** Empty state: one line of copy, one action, an optional soft icon. */
export function EmptyState({
  icon,
  children,
  action,
  className,
  ...rest
}: {
  icon?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
} & { "data-testid"?: string }) {
  return (
    <div
      className={`flex flex-col items-center gap-4 px-6 py-10 text-center${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {icon ? (
        <span
          aria-hidden
          className="flex h-14 w-14 items-center justify-center rounded-full bg-fill text-muted"
        >
          <IonIcon icon={icon} className="h-7 w-7" />
        </span>
      ) : null}
      <p className="max-w-xs text-muted">{children}</p>
      {action}
    </div>
  );
}

/** A grey block that pulses (reduced motion: static). Decorative; wrap in `<SkeletonRegion>`. */
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div aria-hidden className={`ll-skeleton${className ? ` ${className}` : ""}`} style={style} />
  );
}

/** Announces a loading region once; skeleton children stay silent. */
export function SkeletonRegion({
  children,
  className,
  label = t("common.loading"),
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      {children}
    </div>
  );
}

/** Photo-grid placeholder (squares, 2 px gaps). */
export function GridSkeleton({ count = 12, cols = 3 }: { count?: number; cols?: number }) {
  return (
    <SkeletonRegion>
      <div
        className="grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
          <Skeleton key={i} className="aspect-square !rounded-none" />
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** List-row placeholder. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <SkeletonRegion className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={i} className="flex flex-col gap-2 rounded-xl bg-surface p-4">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3.5 w-3/5" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** Whole-page placeholder used while the session loads (never a spinner). */
export function PageSkeleton() {
  return (
    <SkeletonRegion className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-4 py-12">
      <Skeleton className="h-8 w-3/5" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-11 w-full !rounded-xl" />
      <Skeleton className="h-11 w-full !rounded-xl" />
    </SkeletonRegion>
  );
}
