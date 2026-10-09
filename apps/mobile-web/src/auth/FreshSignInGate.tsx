import { IonModal } from "@ionic/react";
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { CodeEntry } from "../components/CodeEntry";
import { Button } from "../components/ui";
import { t } from "../i18n";
import { isApiError } from "../lib/api";
import { useAuth } from "./AuthProvider";

type WithFresh = <T>(action: () => Promise<T>) => Promise<T>;
const GateContext = createContext<WithFresh | null>(null);

/**
 * Wraps destructive actions that need a fresh sign-in (delete baby, remove co-admin, confirm
 * removal, leave, delete account). Runs the action; on 403 `fresh_sign_in_required` it opens a
 * re-verify-by-email-code dialog, then retries once. Rejects if the user cancels.
 */
export function FreshSignInProvider({ children }: { children: ReactNode }) {
  const { me, refetchMe } = useAuth();
  const [open, setOpen] = useState(false);
  const waiter = useRef<{ ok: () => void; cancel: () => void } | null>(null);

  const withFresh = useCallback<WithFresh>(async (action) => {
    try {
      return await action();
    } catch (e) {
      if (!isApiError(e, "fresh_sign_in_required")) throw e;
      await new Promise<void>((resolve, reject) => {
        waiter.current = { ok: resolve, cancel: () => reject(e) };
        setOpen(true);
      });
      return action();
    }
  }, []);

  const close = (verified: boolean) => {
    setOpen(false);
    const w = waiter.current;
    waiter.current = null;
    if (verified) w?.ok();
    else w?.cancel();
  };

  const email = me?.user.email ?? null;

  return (
    <GateContext.Provider value={withFresh}>
      {children}
      <IonModal
        isOpen={open}
        onDidDismiss={() => waiter.current && close(false)}
        data-testid="fresh-gate"
        className="ll-sheet"
      >
        {email ? (
          <div className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <h2 className="text-xl font-semibold">{t("gate.title")}</h2>
            <p className="text-muted">{t("gate.body", { email })}</p>
            <CodeEntry
              email={email}
              sendOnMount
              onVerified={async () => {
                await refetchMe();
                close(true);
              }}
            />
            <Button
              variant="secondary"
              data-testid="fresh-gate-cancel"
              onClick={() => close(false)}
            >
              {t("gate.cancel")}
            </Button>
          </div>
        ) : null}
      </IonModal>
    </GateContext.Provider>
  );
}

export function useFreshSignIn(): WithFresh {
  const ctx = useContext(GateContext);
  if (!ctx) throw new Error("useFreshSignIn must be used inside <FreshSignInProvider>");
  return ctx;
}
