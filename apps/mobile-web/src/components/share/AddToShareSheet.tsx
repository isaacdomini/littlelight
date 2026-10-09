import { IonModal } from "@ionic/react";
import type { ShareLink } from "@littlelight/shared";
import { useEffect, useState } from "react";
import { t, tn } from "../../i18n";
import { errorMessage } from "../../lib/api";
import {
  useAddToShareLink,
  usePhotoShareLinks,
  useRemoveFromShareLink,
  useShareLinks,
} from "../../lib/queries/sharing";
import { Button, CheckField, ListSkeleton, Message } from "../ui";
import { CreateShareLinkForm } from "./CreateShareLinkSheet";
import { ShareUrlBody } from "./ShareUrlSheet";

type Mode = "pick" | "create" | "url";

interface AddToShareSheetProps {
  open: boolean;
  babyId: string;
  plus: boolean;
  /** Photos to add. A single photo shows (and can undo) its current membership. */
  photoIds: string[];
  /** How many of them the AI flagged sensitive (hidden from family unless turned on). */
  sensitiveCount: number;
  onClose: () => void;
  /** Result line for a toast after a successful update. */
  onDone: (message: string) => void;
}

function Picker({
  babyId,
  plus,
  photoIds,
  sensitiveCount,
  onClose,
  onDone,
}: Omit<AddToShareSheetProps, "open">) {
  const single = photoIds.length === 1 ? photoIds[0] : undefined;
  const links = useShareLinks(babyId);
  const membership = usePhotoShareLinks(single);
  const add = useAddToShareLink(babyId);
  const remove = useRemoveFromShareLink(babyId);
  const [mode, setMode] = useState<Mode>("pick");
  const [url, setUrl] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [showSensitive, setShowSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const was = (id: string) => membership.data?.find((m) => m.shareLinkId === id)?.shared ?? false;
  const isOn = (id: string) => checked[id] ?? was(id);

  // Pre-check from the photo's current membership once it loads.
  useEffect(() => {
    if (membership.data) setChecked({});
  }, [membership.data]);

  const changes = (links.data ?? []).filter(
    (l) => isOn(l.id) !== was(l.id) || (!single && isOn(l.id)),
  );

  async function result(parts: {
    added: number;
    hidden: number;
    skipped: number;
    removed: number;
  }) {
    const bits = [
      parts.added > 0 ? tn("share.add.added", parts.added) : null,
      parts.removed > 0 ? tn("share.add.removed", parts.removed) : null,
      parts.hidden > 0 ? tn("share.add.hiddenResult", parts.hidden) : null,
      parts.skipped > 0 ? tn("share.add.skipped", parts.skipped) : null,
    ].filter(Boolean);
    onDone(bits.length > 0 ? bits.join(" ") : t("share.add.nothing"));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const totals = { added: 0, hidden: 0, skipped: 0, removed: 0 };
    try {
      for (const l of changes) {
        if (single && was(l.id) && !isOn(l.id)) {
          const r = await remove.mutateAsync({ linkId: l.id, photoIds });
          totals.removed += r.removed;
        } else if (isOn(l.id)) {
          const r = await add.mutateAsync({ linkId: l.id, photoIds, showSensitive });
          totals.added += r.added;
          totals.hidden += r.hidden;
          totals.skipped += r.skipped.length;
        }
      }
      await result(totals);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function addToNew(link: ShareLink["id"], created: { url: string }) {
    setBusy(true);
    try {
      const r = await add.mutateAsync({ linkId: link, photoIds, showSensitive });
      setUrl(created.url);
      setMode("url");
      await result({ added: r.added, hidden: r.hidden, skipped: r.skipped.length, removed: 0 });
    } catch (e) {
      setError(errorMessage(e));
      setUrl(created.url);
      setMode("url");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "create") {
    return (
      <CreateShareLinkForm
        babyId={babyId}
        plus={plus}
        onCancel={() => setMode("pick")}
        onCreated={(c) => void addToNew(c.link.id, c)}
      />
    );
  }
  if (mode === "url" && url) return <ShareUrlBody url={url} onDone={onClose} />;

  const selectable = (links.data ?? []).filter((l) => l.status !== "revoked");
  return (
    <div
      className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      data-testid="share-add-sheet"
    >
      <h2 className="text-xl font-semibold">{tn("share.add.title", photoIds.length)}</h2>
      {links.isPending ? <ListSkeleton rows={2} /> : null}
      {links.isError ? <Message>{errorMessage(links.error)}</Message> : null}
      {links.data && selectable.length === 0 ? (
        <p className="text-muted" data-testid="share-add-none">
          {t("share.add.none")}
        </p>
      ) : null}
      {selectable.length > 0 ? (
        <ul className="ll-list">
          {selectable.map((l) => (
            <li key={l.id} className="!py-0">
              <CheckField
                data-testid={`share-target-${l.id}`}
                checked={isOn(l.id)}
                onChange={(e) => setChecked((c) => ({ ...c, [l.id]: e.target.checked }))}
                label={
                  <span className="flex flex-col">
                    <span className="font-semibold">{l.name}</span>
                    <span className="text-sm text-muted">
                      {l.status === "expired"
                        ? t("share.status.expired")
                        : tn("share.photoCount", l.photoCount)}
                    </span>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
      {sensitiveCount > 0 ? (
        <div className="ll-callout flex flex-col gap-1" data-testid="share-sensitive-notice">
          <p>{tn("share.add.sensitive", sensitiveCount)}</p>
          <CheckField
            data-testid="share-show-sensitive-toggle"
            label={t("share.add.showSensitive")}
            checked={showSensitive}
            onChange={(e) => setShowSensitive(e.target.checked)}
          />
        </div>
      ) : null}
      {error ? <Message data-testid="share-add-error">{error}</Message> : null}
      <div className="flex flex-col gap-2">
        <Button
          data-testid="share-add-submit"
          disabled={busy || changes.length === 0}
          onClick={() => void submit()}
        >
          {t("share.add.submit")}
        </Button>
        <Button
          variant="secondary"
          data-testid="share-add-new"
          disabled={busy}
          onClick={() => setMode("create")}
        >
          {t("share.add.new")}
        </Button>
        <Button variant="link" data-testid="share-add-cancel" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** "Add to shared album" (FR-9.3, FR-8.4): pick links, add or (single photo) remove, or create one. */
export function AddToShareSheet(props: AddToShareSheetProps) {
  return (
    <IonModal isOpen={props.open} onDidDismiss={props.onClose} className="ll-sheet">
      {props.open ? <Picker {...props} /> : null}
    </IonModal>
  );
}
