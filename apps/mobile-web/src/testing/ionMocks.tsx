import type { ReactNode } from "react";

// Test doubles for the two Ionic overlays the import UI uses (jsdom does not run Ionic's web
// components). Import this file's exports inside `vi.mock("@ionic/react", ...)`. Test-only.

export function FakeModal({ isOpen, children }: { isOpen?: boolean; children?: ReactNode }) {
  return isOpen ? <div data-testid="modal">{children}</div> : null;
}

export interface FakeAlertButton {
  text: string;
  role?: string;
  handler?: () => void;
}

export function FakeAlert({
  isOpen,
  header,
  message,
  buttons,
  onWillDismiss,
}: {
  isOpen?: boolean;
  header?: string;
  message?: string;
  buttons?: FakeAlertButton[];
  onWillDismiss?: () => void;
}) {
  if (!isOpen) return null;
  return (
    <div role="alertdialog" data-testid="alert">
      <h2>{header}</h2>
      <p>{message}</p>
      {(buttons ?? []).map((b) => (
        <button
          type="button"
          key={b.text}
          onClick={() => {
            b.handler?.();
            onWillDismiss?.();
          }}
        >
          {b.text}
        </button>
      ))}
    </div>
  );
}
