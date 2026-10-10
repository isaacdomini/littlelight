import type { ShareLink, ShareLinkCreatedResponse } from "@tinyglow/shared";
import { linkOutline } from "ionicons/icons";
import { useState } from "react";
import { t } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { useShareLinks } from "../../lib/queries/sharing";
import { Button, EmptyState, ListSkeleton, Message } from "../ui";
import { CreateShareLinkSheet } from "./CreateShareLinkSheet";
import { ShareLinkCard } from "./ShareLinkCard";
import { ShareLinkSettingsSheet } from "./ShareLinkSettingsSheet";
import { ShareUrlSheet } from "./ShareUrlSheet";

/** Family tab section (admins only): the baby's share links and the one-time URL sheet. */
export function ShareLinksSection({ babyId, plus }: { babyId: string; plus: boolean }) {
  const links = useShareLinks(babyId);
  const [createOpen, setCreateOpen] = useState(false);
  const [settings, setSettings] = useState<ShareLink | null>(null);
  // The one-time URL: component state only (D1).
  const [url, setUrl] = useState<string | null>(null);

  const showUrl = (created: ShareLinkCreatedResponse) => {
    setCreateOpen(false);
    setUrl(created.url);
  };

  return (
    <section
      aria-labelledby="share-links-h"
      className="flex flex-col gap-4"
      data-testid="share-links-section"
    >
      <div className="flex flex-col gap-1">
        <h2 id="share-links-h" className="text-xl font-semibold">
          {t("share.title")}
        </h2>
        <p className="text-sm text-muted">{t("share.intro")}</p>
      </div>
      {links.isError ? <Message>{errorMessage(links.error)}</Message> : null}
      {links.isPending && !links.isError ? <ListSkeleton rows={1} /> : null}
      {links.data && links.data.length === 0 ? (
        <EmptyState
          icon={linkOutline}
          className="ll-card"
          data-testid="share-links-empty"
          action={
            <Button data-testid="share-create-open" onClick={() => setCreateOpen(true)}>
              {t("share.new")}
            </Button>
          }
        >
          {t("share.empty")}
        </EmptyState>
      ) : null}
      {links.data && links.data.length > 0 ? (
        <>
          <ul className="flex flex-col gap-3" data-testid="share-links-list">
            {links.data.map((l) => (
              <ShareLinkCard key={l.id} link={l} onUrl={showUrl} onSettings={setSettings} />
            ))}
          </ul>
          <Button
            variant="secondary"
            className="self-start"
            data-testid="share-create-open"
            onClick={() => setCreateOpen(true)}
          >
            {t("share.new")}
          </Button>
        </>
      ) : null}

      <CreateShareLinkSheet
        open={createOpen}
        babyId={babyId}
        plus={plus}
        onCreated={showUrl}
        onClose={() => setCreateOpen(false)}
      />
      <ShareLinkSettingsSheet link={settings} plus={plus} onClose={() => setSettings(null)} />
      <ShareUrlSheet url={url} onClose={() => setUrl(null)} />
    </section>
  );
}
