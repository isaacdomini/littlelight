import { IonContent, IonPage } from "@ionic/react";
import { type BabyRole, emailSchema, inviteSchema, type Member } from "@littlelight/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { peopleOutline } from "ionicons/icons";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ME_KEY, useAuth, useCurrentBaby } from "../auth/AuthProvider";
import { useFreshSignIn } from "../auth/FreshSignInGate";
import { AiUsage } from "../components/AiUsage";
import { AppHeader } from "../components/AppHeader";
import { ShareLinksSection } from "../components/share/ShareLinksSection";
import {
  Button,
  Card,
  EmptyState,
  ListSkeleton,
  Message,
  SelectField,
  TextField,
} from "../components/ui";
import { t } from "../i18n";
import { apiRequest, errorMessage } from "../lib/api";
import { membersKey, useMembers } from "../lib/queries";

const roleLabel = (r: BabyRole) => t(r === "admin" ? "role.adminLabel" : "role.contributorLabel");
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString();

export function FamilyPage() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const { baby } = useCurrentBaby();
  const qc = useQueryClient();
  const withFresh = useFreshSignIn();
  const members = useMembers(baby?.id);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<BabyRole>("contributor");

  const babyId = baby?.id;
  const myId = me?.user.id;
  const isAdmin = baby?.role === "admin";
  const refresh = () => qc.invalidateQueries({ queryKey: membersKey(babyId ?? "none") });

  const run = useMutation({
    mutationFn: async (job: () => Promise<string | null>) => job(),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (msg) => {
      setNotice(msg);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const act = (job: () => Promise<string | null>) => run.mutate(job);
  const base = `/babies/${babyId}`;

  function onInvite(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError(t("invite.invalidEmail"));
      return;
    }
    act(async () => {
      await apiRequest(`${base}/invites`, {
        method: "POST",
        body: { email: parsed.data, role },
        schema: inviteSchema,
      });
      setEmail("");
      return t("invite.sent", { email: parsed.data });
    });
  }

  const removeMember = (m: Member) =>
    act(async () => {
      const res = await withFresh(() =>
        apiRequest(`${base}/members/${m.userId}`, { method: "DELETE" }),
      );
      return res.status === 202 ? t("family.removeRequested") : null;
    });

  const leave = () =>
    act(async () => {
      await withFresh(() => apiRequest(`${base}/members/${myId}`, { method: "DELETE" }));
      await qc.invalidateQueries({ queryKey: ME_KEY });
      return null;
    });

  const answerRemoval = (m: Member, answer: "confirm" | "decline") =>
    act(async () => {
      const call = () =>
        apiRequest(`${base}/members/${m.userId}/removal/${answer}`, { method: "POST" });
      await (answer === "confirm" ? withFresh(call) : call());
      if (answer === "confirm") await qc.invalidateQueries({ queryKey: ME_KEY });
      return null;
    });

  const data = members.data;
  const myMember = data?.members.find((m) => m.userId === myId);
  const removalForMe = myMember?.removalRequestedBy ? myMember : null;

  return (
    <IonPage>
      <AppHeader title={t("family.title")} />
      <IonContent className="ion-padding">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8" data-testid="family">
          {!baby ? (
            <EmptyState
              icon={peopleOutline}
              action={
                <Button onClick={() => navigate("/onboarding/baby?another=1")}>
                  {t("header.addBaby")}
                </Button>
              }
            >
              {t("family.noBaby")}
            </EmptyState>
          ) : null}
          {removalForMe && baby ? (
            <Card tone="danger">
              <div role="alert" data-testid="removal-banner">
                <h2 className="font-semibold">{t("family.removalBannerTitle")}</h2>
                <p className="mb-4 mt-1">{t("family.removalBannerBody", { baby: baby.name })}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    data-testid="removal-confirm"
                    onClick={() => answerRemoval(removalForMe, "confirm")}
                  >
                    {t("family.confirmRemoval")}
                  </Button>
                  <Button
                    variant="secondary"
                    data-testid="removal-decline"
                    onClick={() => answerRemoval(removalForMe, "decline")}
                  >
                    {t("family.declineRemoval")}
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}
          {error ? <Message data-testid="family-error">{error}</Message> : null}
          {notice ? (
            <Message kind="info" data-testid="family-notice">
              {notice}
            </Message>
          ) : null}
          {members.isError ? <Message>{errorMessage(members.error)}</Message> : null}
          {baby && members.isPending && !members.isError ? <ListSkeleton rows={3} /> : null}

          {isAdmin && baby ? (
            <ShareLinksSection babyId={baby.id} plus={baby.plan !== "free"} />
          ) : null}

          {data ? (
            <section aria-labelledby="members-h">
              <h2 id="members-h" className="mb-3 text-xl font-semibold">
                {t("family.members")}
              </h2>
              <ul className="ll-list" data-testid="members-list">
                {data.members.map((m) => {
                  const mine = m.userId === myId;
                  const pending = !!m.removalRequestedBy;
                  return (
                    <li
                      key={m.userId}
                      className="ll-row !flex-nowrap"
                      data-testid={`member-${m.role}`}
                    >
                      <span
                        aria-hidden
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fill font-semibold text-muted"
                      >
                        {m.displayName.trim().charAt(0).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">
                          {m.displayName} {mine ? t("family.you") : ""}
                        </p>
                        <p className="text-sm text-muted">
                          {[roleLabel(m.role), m.relationshipLabel].filter(Boolean).join(", ")}
                        </p>
                        {pending && !mine ? (
                          <p className="text-sm">{t("family.removalPending")}</p>
                        ) : null}
                      </div>
                      {isAdmin && !mine ? (
                        pending ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => answerRemoval(m, "decline")}
                          >
                            {t("family.cancelRequest")}
                          </Button>
                        ) : (
                          <div className="flex flex-col items-end">
                            <Button
                              variant="danger"
                              size="sm"
                              data-testid={`member-remove-${m.role}`}
                              onClick={() => removeMember(m)}
                            >
                              {t("family.remove")}
                            </Button>
                            {m.role === "admin" ? (
                              <span className="ll-caption max-w-40 text-right">
                                {t("family.removeAdminNote")}
                              </span>
                            ) : null}
                          </div>
                        )
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {baby && myMember ? (
                <Button
                  variant="danger"
                  className="mt-3"
                  data-testid="leave-album"
                  onClick={() => {
                    if (window.confirm(t("family.leaveConfirm", { baby: baby.name }))) leave();
                  }}
                >
                  {t("family.leave")}
                </Button>
              ) : null}
            </section>
          ) : null}

          {isAdmin && data ? (
            <section aria-labelledby="invites-h" className="flex flex-col gap-4">
              <h2 id="invites-h" className="text-xl font-semibold">
                {t("family.invites")}
              </h2>
              <form onSubmit={onInvite} className="flex flex-col gap-4" noValidate>
                <TextField
                  data-testid="family-invite-email"
                  label={t("family.inviteNew")}
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <SelectField
                  id="invite-role"
                  label={t("family.inviteRole")}
                  data-testid="family-invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as BabyRole)}
                >
                  <option value="contributor">{roleLabel("contributor")}</option>
                  <option value="admin">{roleLabel("admin")}</option>
                </SelectField>
                <Button
                  type="submit"
                  data-testid="family-invite-send"
                  disabled={run.isPending || email.trim() === ""}
                >
                  {t("invite.send")}
                </Button>
              </form>
              {data.invites.length > 0 ? (
                <>
                  <h3 className="ll-label">{t("family.invitePending")}</h3>
                  <ul className="ll-list" data-testid="invites-list">
                    {data.invites.map((inv) => (
                      <li key={inv.id} className="ll-row">
                        <div>
                          <p className="font-semibold">{inv.email}</p>
                          <p className="text-sm text-muted">
                            {roleLabel(inv.role)},{" "}
                            {t("family.expires", { date: fmtDate(inv.expiresAt) })}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            data-testid="invite-resend"
                            onClick={() =>
                              act(async () => {
                                await apiRequest(`${base}/invites/${inv.id}/resend`, {
                                  method: "POST",
                                  schema: inviteSchema,
                                });
                                return t("invite.sent", { email: inv.email });
                              })
                            }
                          >
                            {t("common.resend")}
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            data-testid="invite-revoke"
                            onClick={() =>
                              act(async () => {
                                await apiRequest(`${base}/invites/${inv.id}`, { method: "DELETE" });
                                return null;
                              })
                            }
                          >
                            {t("common.revoke")}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}
          {isAdmin && baby ? <AiUsage babyId={baby.id} paid={baby.plan !== "free"} /> : null}
        </div>
      </IonContent>
    </IonPage>
  );
}
