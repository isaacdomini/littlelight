import { SHARE_PASSCODE_LENGTH } from "@littlelight/shared";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { ShareApiError } from "../../lib/shareApi";
import { FlowPage } from "../Page";
import { Button, Message, TextField } from "../ui";
import { NativeDone } from "./NativeDone";

/** Passcode entry for a protected link: 6 digits, submits at the last digit. */
export function PasscodeForm({
  onSubmit,
  initialError,
}: {
  onSubmit: (code: string) => Promise<void>;
  initialError?: ShareApiError | null;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShareApiError | null>(initialError ?? null);
  const input = useRef<HTMLInputElement>(null);
  const sent = useRef<string | null>(null);

  const locked = error && error.status === 429;
  const minutes = error?.retryAfterSec ? Math.max(1, Math.ceil(error.retryAfterSec / 60)) : null;

  async function submit(value: string) {
    if (value.length !== SHARE_PASSCODE_LENGTH || sent.current === value || busy) return;
    sent.current = value;
    setBusy(true);
    try {
      await onSubmit(value);
    } catch (e) {
      setError(e instanceof ShareApiError ? e : null);
      setCode("");
      sent.current = null;
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (code.length === SHARE_PASSCODE_LENGTH) void submit(code);
    // biome-ignore lint/correctness/useExhaustiveDependencies: submit reads current state
  }, [code, submit]);

  let message: string | null = null;
  if (error) {
    if (locked) {
      message = minutes
        ? t("shareViewer.passcodeLocked", { minutes })
        : t("shareViewer.passcodeLockedNoTime");
    } else if (error.code === "passcode_invalid") {
      const left = (error.details as { attemptsLeft?: number } | undefined)?.attemptsLeft;
      message =
        typeof left === "number"
          ? t(left === 1 ? "shareViewer.passcodeWrongOne" : "shareViewer.passcodeWrong", {
              n: left,
            })
          : t("shareViewer.passcodeWrongNoCount");
    } else {
      message = error.message;
    }
  }

  return (
    <FlowPage
      title={t("shareViewer.passcodeTitle")}
      subtitle={t("shareViewer.passcodeBody")}
      testId="share-passcode"
      brand
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
      >
        <TextField
          ref={input}
          data-testid="share-passcode-field"
          label={t("shareViewer.passcodeLabel")}
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]*"
          maxLength={SHARE_PASSCODE_LENGTH}
          autoFocus
          value={code}
          disabled={busy || !!locked}
          onChange={(e) =>
            setCode(e.target.value.replace(/\D/g, "").slice(0, SHARE_PASSCODE_LENGTH))
          }
          className="text-center text-2xl font-semibold tracking-[0.5em]"
        />
        <div aria-live="polite">
          {message ? <Message data-testid="share-passcode-error">{message}</Message> : null}
        </div>
        <Button
          type="submit"
          data-testid="share-passcode-submit"
          disabled={busy || !!locked || code.length !== SHARE_PASSCODE_LENGTH}
        >
          {t("shareViewer.passcodeSubmit")}
        </Button>
      </form>
      <NativeDone />
    </FlowPage>
  );
}
