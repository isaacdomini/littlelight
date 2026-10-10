import { OTP_CODE_LENGTH } from "@tinyglow/shared";
import {
  type ClipboardEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { t } from "../i18n";
import { errorMessage, isApiError } from "../lib/api";
import { requestCode, verifyCode } from "../lib/authApi";
import { useAuthConfig } from "../lib/queries";
import { Turnstile } from "./Turnstile";
import { Button, Message, TextField } from "./ui";

const COOLDOWN_SEC = 60;

/**
 * 6-digit code input + resend, shared by the Verify screen and the fresh-sign-in gate.
 * Supports paste and iOS/Android one-time-code autofill; submits automatically at 6 digits.
 * The email is never logged.
 */
export function CodeEntry({
  email,
  sendOnMount = false,
  onVerified,
}: {
  email: string;
  /** Request a code when mounted (re-verification flows); the Welcome screen already did. */
  sendOnMount?: boolean;
  onVerified: () => void | Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(COOLDOWN_SEC);
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef<string | null>(null);
  const sentOnMount = useRef(false);
  const config = useAuthConfig();

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const send = useCallback(
    async (token?: string) => {
      setError(null);
      try {
        await requestCode(email, token);
        setNeedCaptcha(false);
        setCaptchaToken(undefined);
        setCooldown(COOLDOWN_SEC);
        setInfo(t("verify.resent"));
      } catch (e) {
        if (isApiError(e, "captcha_required") || isApiError(e, "captcha_failed")) {
          setNeedCaptcha(true);
          setCaptchaToken(undefined);
        }
        setError(errorMessage(e));
      }
    },
    [email],
  );

  useEffect(() => {
    if (sendOnMount && !sentOnMount.current) {
      sentOnMount.current = true;
      void send();
    }
  }, [sendOnMount, send]);

  const submit = useCallback(
    async (value: string) => {
      if (value.length !== OTP_CODE_LENGTH || submitted.current === value) return;
      submitted.current = value;
      setBusy(true);
      setError(null);
      try {
        await verifyCode(email, value);
        await onVerified();
      } catch (e) {
        setError(errorMessage(e));
        setCode("");
        submitted.current = null;
        inputRef.current?.focus();
      } finally {
        setBusy(false);
      }
    },
    [email, onVerified],
  );

  useEffect(() => {
    if (code.length === OTP_CODE_LENGTH) void submit(code);
  }, [code, submit]);

  const digits = (s: string) => s.replace(/\D/g, "").slice(0, OTP_CODE_LENGTH);

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    setCode(digits(e.clipboardData.getData("text")));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(code);
  }

  const siteKey = config.data?.turnstileSiteKey ?? null;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        ref={inputRef}
        data-testid="verify-code"
        label={t("verify.codeLabel")}
        hint={t("verify.hint")}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={OTP_CODE_LENGTH}
        autoFocus
        value={code}
        onChange={(e) => setCode(digits(e.target.value))}
        onPaste={onPaste}
        disabled={busy}
        className="text-center text-2xl font-semibold tracking-[0.5em]"
      />
      <div aria-live="polite">
        {error ? <Message data-testid="verify-error">{error}</Message> : null}
        {!error && info ? <Message kind="info">{info}</Message> : null}
      </div>
      <Button
        type="submit"
        data-testid="verify-submit"
        disabled={busy || code.length !== OTP_CODE_LENGTH}
      >
        {t("verify.submit")}
      </Button>
      {needCaptcha && siteKey ? <Turnstile siteKey={siteKey} onToken={setCaptchaToken} /> : null}
      <Button
        variant="link"
        data-testid="verify-resend"
        disabled={busy || cooldown > 0 || (needCaptcha && !captchaToken)}
        onClick={() => void send(captchaToken)}
      >
        {cooldown > 0 ? t("verify.resendIn", { seconds: cooldown }) : t("verify.resend")}
      </Button>
    </form>
  );
}
