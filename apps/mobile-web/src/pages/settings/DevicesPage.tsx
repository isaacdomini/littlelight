import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSignOut } from "../../auth/useSignOut";
import { SubPage } from "../../components/Page";
import { Button, Message } from "../../components/ui";
import { t } from "../../i18n";
import { apiFetch, errorMessage } from "../../lib/api";
import { SESSIONS_KEY, useSessions } from "../../lib/queries";

export function DevicesPage() {
  const qc = useQueryClient();
  const signOut = useSignOut();
  const sessions = useSessions();
  const [error, setError] = useState<string | null>(null);

  const signOutDevice = useMutation({
    mutationFn: async (s: { id: string; current: boolean }) => {
      await apiFetch(`/auth/sessions/${s.id}`, { method: "DELETE" });
      return s.current;
    },
    onSuccess: (wasCurrent) => {
      if (wasCurrent) void signOut("local");
      else void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <SubPage title={t("devices.title")} backHref="/settings">
      <p className="text-muted">{t("devices.body")}</p>
      {sessions.isError ? <Message>{errorMessage(sessions.error)}</Message> : null}
      {error ? <Message>{error}</Message> : null}
      <ul className="ll-list" data-testid="devices-list">
        {sessions.data?.sessions.map((s) => (
          <li key={s.id} className="ll-row !flex-nowrap">
            <div className="min-w-0">
              <p className="font-semibold">
                {s.deviceLabel} {s.current ? `(${t("devices.current")})` : ""}
              </p>
              <p className="text-sm text-muted">
                {t("devices.lastActive", { date: new Date(s.lastActiveAt).toLocaleString() })}
                {s.signInMethod ? (
                  <>
                    {" · "}
                    <span data-testid="devices-method">
                      {t(`devices.method.${s.signInMethod}`)}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
            <Button
              variant="secondary"
              data-testid={s.current ? "devices-signout-current" : "devices-signout"}
              disabled={signOutDevice.isPending}
              onClick={() => {
                setError(null);
                signOutDevice.mutate({ id: s.id, current: s.current });
              }}
            >
              {t("devices.signOut")}
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="danger"
        data-testid="devices-signout-all"
        onClick={() => void signOut("global")}
      >
        {t("devices.signOutAll")}
      </Button>
    </SubPage>
  );
}
