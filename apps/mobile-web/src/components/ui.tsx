import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
} from "react";

// Native, accessible form primitives (44px targets, visible labels, dark mode via Ionic vars).
// Native elements keep `data-testid` + Playwright `fill`/`check` working inside Capacitor too.

const fieldBase =
  "min-h-11 w-full rounded-lg border border-gray-500/50 bg-transparent px-3 py-2 text-base text-[var(--ion-text-color)] outline-none focus:border-[var(--ion-color-primary)] focus:ring-2 focus:ring-[var(--ion-color-primary)]";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        className={`${fieldBase} ${className ?? ""}`}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        {...rest}
      />
      {hint ? (
        <p id={`${inputId}-hint`} className="text-sm opacity-70">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

export function CheckField({
  label,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }) {
  return (
    <label className="flex min-h-11 items-start gap-3 py-2 text-base">
      <input
        type="checkbox"
        className="mt-1 h-6 w-6 shrink-0 accent-[var(--ion-color-primary)]"
        {...rest}
      />
      <span>{label}</span>
    </label>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "link";
}

export function Button({ variant = "primary", className, type = "button", ...rest }: ButtonProps) {
  const styles = {
    primary: "bg-[var(--ion-color-primary)] text-[var(--ion-color-primary-contrast)] font-semibold",
    secondary: "border border-gray-500/50 bg-transparent",
    danger: "bg-red-600 text-white font-semibold",
    link: "bg-transparent underline",
  }[variant];
  return (
    <button
      type={type}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-4 py-2 text-base disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className ?? ""}`}
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
      className={
        kind === "error"
          ? "text-sm font-medium text-red-600 dark:text-red-400"
          : "text-sm opacity-80"
      }
      {...rest}
    >
      {children}
    </p>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-gray-500/30 p-4 ${className ?? ""}`}>
      {children}
    </section>
  );
}
