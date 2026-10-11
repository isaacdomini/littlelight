import { useQuery } from "@tanstack/react-query";
import {
  type InviteAcceptResponse,
  inviteAcceptResponseSchema,
  inviteLookupResponseSchema,
} from "@tinyglow/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useRouteActive } from "../auth/guards";
import { useSignOut } from "../auth/useSignOut";
import { FlowPage } from "../components/Page";
import { Button, Message } from "../components/ui";
import { t } from "../i18n";
import { type ApiError, apiFetch, isApiError } from "../lib/api";
import { memberError } from "../lib/familyErrors";
import { pendingInvite } from "../lib/session";

type Outcome =
  | { kind: "accepting" }
  | { kind: "joined"; result: InviteAcceptResponse }
  | { kind: "mismatch"; message: string }
  | { kind: "failed"; code: ApiError["code"]; message: string };

/**
 * `/invite/:token`. Signed out: remember the token and go sign in. Signed in and onboarded:
 * accept automatically (the server enforces that the signed-in email matches the invited one).
 */
export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const { me, isLoading, refetchMe, setCurrentBabyId } = useAuth();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "accepting" });
  const started = useRef(false);

  const lookup = useQuery({
    queryKey: ["invite", token],
    queryFn: () => apiFetch(`/invites/${token}`, { schema: inviteLookupResponseSchema }),
    retry: false,
    staleTime: Infinity,
  });

  const needsOnboarding = me
    ? !me.consent.ok
      ? "/onboarding/consent"
      : !me.profileComplete
        ? "/onboarding/profile"
        : null
    : null;

  const active = useRouteActive("/invite/:token");

  useEffect(() => {
    if (isLoading || !active) return;
    if (!me) {
      pendingInvite.set(token);
      navigate("/welcome", { replace: true });
    } else if (needsOnboarding) {
      pendingInvite.set(token);
      navigate(needsOnboarding, { replace: true });
    }
  }, [isLoading, active, me, needsOnboarding, token, navigate]);

  useEffect(() => {
    if (!me || needsOnboarding || !lookup.data || started.current) return;
    if (lookup.data.status !== "valid") return;
    started.current = true;
    apiFetch(`/invites/${token}/accept`, { method: "POST", schema: inviteAcceptResponseSchema })
      .then(async (result) => {
        pendingInvite.clear();
        await refetchMe();
        setCurrentBabyId(result.babyId);
        setOutcome({ kind: "joined", result });
      })
      .catch((e: unknown) => {
        if (isApiError(e, "invite_email_mismatch")) {
          // Keep the pending token so the right account can finish after switching.
          setOutcome({ kind: "mismatch", message: e.message });
          return;
        }
        pendingInvite.clear();
        setOutcome({
          kind: "failed",
          code: isApiError(e) ? e.code : "unknown",
          message: memberError(e, "invitee"),
        });
      });
  }, [me, needsOnboarding, lookup.data, token, refetchMe, setCurrentBabyId]);

  if (isLoading || !me || needsOnboarding)
    return (
      <FlowPage title={t("accept.title")} testId="invite-page">
        <Message kind="info">{t("common.loading")}</Message>
      </FlowPage>
    );

  const info = lookup.data;
  const summary = info
    ? t(info.inviterName ? "accept.summary" : "accept.summaryNoInviter", {
        inviter: info.inviterName ?? "",
        baby: info.babyName,
        role: t(info.role === "admin" ? "role.admin" : "role.contributor"),
      })
    : "";

  let body: ReactNode;
  if (lookup.isError) {
    pendingInvite.clear();
    body = <Message data-testid="invite-failed">{t("accept.notFound")}</Message>;
  } else if (info && info.status !== "valid") {
    pendingInvite.clear();
    body = (
      <Message data-testid="invite-failed">
        {info.status === "accepted" ? t("accept.alreadyUsed") : t("accept.expired")}
      </Message>
    );
  } else if (outcome.kind === "mismatch") {
    body = (
      <>
        <Message data-testid="invite-mismatch">{outcome.message}</Message>
        <Button data-testid="invite-switch-account" onClick={() => void signOut("local")}>
          {t("accept.useOther")}
        </Button>
      </>
    );
  } else if (outcome.kind === "failed") {
    const text =
      outcome.code === "admins_full"
        ? t("accept.adminsFull")
        : outcome.code === "invite_expired" || outcome.code === "invite_revoked"
          ? t("accept.expired")
          : outcome.code === "invite_accepted"
            ? t("accept.alreadyUsed")
            : outcome.message;
    body = (
      <>
        <Message data-testid="invite-failed">{text}</Message>
        {outcome.code === "already_parent_elsewhere" ? (
          <Button data-testid="invite-switch-account" onClick={() => void signOut("local")}>
            {t("accept.useDifferentAccount")}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={() =>
            navigate(me.babies.length > 0 ? "/chat" : "/onboarding/baby", { replace: true })
          }
        >
          {me.babies.length > 0 ? t("accept.open") : t("accept.createOwn")}
        </Button>
      </>
    );
  } else if (outcome.kind === "joined") {
    body = (
      <>
        <Message kind="info" data-testid="invite-joined">
          {t("accept.joined", { baby: info?.babyName ?? "" })}
        </Message>
        <Button
          data-testid="invite-accept"
          onClick={() => navigate("/timeline", { replace: true })}
        >
          {t("accept.open")}
        </Button>
      </>
    );
  } else {
    body = <Message kind="info">{t("accept.accepting")}</Message>;
  }

  return (
    <FlowPage title={t("accept.title")} subtitle={summary || undefined} testId="invite-page">
      {body}
    </FlowPage>
  );
}
