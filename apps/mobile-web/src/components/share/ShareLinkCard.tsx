import { IonAlert } from "@ionic/react";
import type { ShareLink, ShareLinkCreatedResponse } from "@tinyglow/shared";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { t, tn } from "../../i18n";
import { errorMessage } from "../../lib/api";
import {
  useDeleteShareLink,
  useRegenerateShareLink,
  useRenewShareLink,
  useRevokeShareLink,
} from "../../lib/queries/sharing";
import { Button, Message } from "../ui";
import { timeAgo, timeUntil } from "./format";

type Confirm = "regenerate" | "revoke" | "delete" | null;

const STATUS_STYLE = {
  active: "text-success-text",
  expired: "text-warning-text",
  revoked: "text-danger-text",
} as const;

/** One share link: status, counts, and the one-tap actions. Links are managed by admins only. */
export function ShareLinkCard({
  link,
  onUrl,
  onSettings,
}: {
  link: ShareLink;
  /** Called with the one-time URL after a regenerate. */
  onUrl: (created: ShareLinkCreatedResponse) => void;
  onSettings: (link: ShareLink) => void;
}) {
  const navigate = useNavigate();
  const renew = useRenewShareLink(link.babyId);
  const regenerate = useRegenerateShareLink(link.babyId);
  const revoke = useRevokeShareLink(link.babyId);
  const del = useDeleteShareLink(link.babyId);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [error, setError] = useState<string | null>(null);

  const revoked = link.status === "revoked";
  const busy = renew.isPending || regenerate.isPending || revoke.isPending || del.isPending;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const statusText =
    link.status === "active"
      ? t("share.status.activeUntil", { time: timeUntil(link.expiresAt) })
      : link.status === "expired"
        ? t("share.status.expired")
        : t("share.status.revoked");

  return (
    <li className="ll-card flex flex-col gap-3" data-testid={`share-link-${link.id}`}>
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 break-words text-lg font-semibold" data-testid="share-link-name">
            {link.name}
          </h3>
          <span
            className={`shrink-0 text-sm font-semibold ${STATUS_STYLE[link.status]}`}
            data-testid="share-link-status"
            data-status={link.status}
          >
            {statusText}
          </span>
        </div>
        <p className="text-sm text-muted" data-testid="share-link-stats">
          {[
            tn("share.photoCount", link.photoCount),
            link.hiddenCount > 0 ? tn("share.hiddenCount", link.hiddenCount) : null,
            link.viewCount > 0
              ? `${tn("share.views", link.viewCount)}${link.lastViewedAt ? `, ${t("share.lastVisit", { when: timeAgo(link.lastViewedAt) })}` : ""}`
              : t("share.neverViewed"),
            link.activeViewers > 0 ? tn("share.activeNow", link.activeViewers) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {link.hasPasscode || link.allowDownload || link.rule ? (
          <ul className="ll-chips !pb-0">
            {link.hasPasscode ? <li className="ll-tag">{t("share.badge.passcode")}</li> : null}
            {link.allowDownload ? <li className="ll-tag">{t("share.badge.download")}</li> : null}
            {link.rule ? <li className="ll-tag">{t("share.badge.rule")}</li> : null}
          </ul>
        ) : null}
      </div>

      {link.passcodeLocked ? (
        <p role="alert" className="ll-callout text-danger-text" data-testid="share-locked">
          {t("share.locked")}
        </p>
      ) : null}
      {error ? <Message data-testid="share-link-error">{error}</Message> : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="!px-3"
          data-testid="share-manage"
          onClick={() => navigate(`/family/share/${link.id}`)}
        >
          {t("share.manage")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="!px-3"
          data-testid="share-renew"
          disabled={busy || revoked}
          onClick={() => void run(() => renew.mutateAsync({ id: link.id }))}
        >
          {t("share.renew")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="!px-3"
          data-testid="share-settings-open"
          disabled={busy}
          onClick={() => onSettings(link)}
        >
          {t("share.settings")}
        </Button>
      </div>
      <div className="-mx-1 flex flex-wrap gap-1">
        <Button
          variant="link"
          size="sm"
          className="!px-3 !text-danger-text"
          data-testid="share-regenerate"
          disabled={busy}
          onClick={() => setConfirm("regenerate")}
        >
          {t("share.regenerate")}
        </Button>
        {revoked ? null : (
          <Button
            variant="link"
            size="sm"
            className="!px-3 !text-danger-text"
            data-testid="share-revoke"
            disabled={busy}
            onClick={() => setConfirm("revoke")}
          >
            {t("share.revoke")}
          </Button>
        )}
        <Button
          variant="link"
          size="sm"
          className="!px-3 !text-danger-text"
          data-testid="share-delete"
          disabled={busy}
          onClick={() => setConfirm("delete")}
        >
          {t("share.delete")}
        </Button>
      </div>

      {/* One alert element per action: an alert still animating out never swallows the next one. */}
      {(["regenerate", "revoke", "delete"] as const).map((kind) => (
        <IonAlert
          key={kind}
          isOpen={confirm === kind}
          header={t(`share.confirm.${kind}.title`)}
          message={t(`share.confirm.${kind}.body`)}
          onWillDismiss={() => setConfirm((c) => (c === kind ? null : c))}
          buttons={[
            { text: t("common.cancel"), role: "cancel" },
            {
              text: t(`share.confirm.${kind}.action`),
              role: "destructive",
              handler: () => {
                if (kind === "regenerate") {
                  void run(async () => onUrl(await regenerate.mutateAsync(link.id)));
                } else if (kind === "revoke") void run(() => revoke.mutateAsync(link.id));
                else void run(() => del.mutateAsync(link.id));
              },
            },
          ]}
        />
      ))}
    </li>
  );
}
