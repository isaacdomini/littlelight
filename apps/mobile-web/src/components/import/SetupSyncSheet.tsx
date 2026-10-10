import { IonModal } from "@ionic/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { t } from "../../i18n";
import { formatCount } from "../../lib/format";
import { importSourcesKey } from "../../lib/queries/imports";
import { type AuthStatus, photoSync } from "../../platform/native/photoSync";
import { Button, CheckField, Message, SelectField, Skeleton, SkeletonRegion } from "../ui";

type Album = { id: string; title: string; count: number };

function SetupBody({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { baby, babies } = useCurrentBaby();
  const adminBabies = babies.filter((b) => b.role === "admin");
  const [auth, setAuth] = useState<AuthStatus | "checking">("checking");
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [babyId, setBabyId] = useState(baby?.id ?? adminBabies[0]?.id ?? "");
  const [wifiOnly, setWifiOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAlbums = useCallback(async () => {
    setAlbums(null);
    setAlbums(await photoSync.albums());
  }, []);

  const apply = useCallback(
    (status: AuthStatus) => {
      setAuth(status);
      if (status === "authorized") void loadAlbums();
    },
    [loadAlbums],
  );

  // Looking at the status never shows the system prompt; only "Allow access" does.
  useEffect(() => {
    let live = true;
    void photoSync.authorization().then((s) => live && apply(s));
    return () => {
      live = false;
    };
  }, [apply]);

  const allow = async () => {
    setBusy(true);
    try {
      apply(await photoSync.requestAuthorization());
    } finally {
      setBusy(false);
    }
  };
  const recheck = async () => {
    setBusy(true);
    try {
      apply(await photoSync.authorization());
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const album = albums?.find((a) => a.id === albumId);
    if (!album || !babyId) return;
    setBusy(true);
    setError(null);
    const res = await photoSync.enable({
      babyId,
      albumId: album.id,
      albumTitle: album.title,
      wifiOnly,
    });
    setBusy(false);
    if (res.ok) {
      void qc.invalidateQueries({ queryKey: importSourcesKey(babyId) });
      onDone();
    } else {
      setError(t(`sync.setup.err.${res.reason}`));
    }
  };

  const needsAccess = auth !== "authorized";

  return (
    <div
      data-testid="sync-setup"
      className="flex max-h-[90vh] flex-col gap-5 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
    >
      <h2 className="text-xl font-semibold">{t("sync.setup.title")}</h2>

      {auth === "checking" ? (
        <SkeletonRegion label={t("common.loading")} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-11 w-full" />
        </SkeletonRegion>
      ) : needsAccess ? (
        <div className="flex flex-col gap-4">
          <p className="text-muted" data-testid="sync-setup-explain">
            {auth === "limited"
              ? t("sync.setup.limited")
              : auth === "denied" || auth === "restricted"
                ? t("sync.setup.denied")
                : t("sync.setup.step1")}
          </p>
          {auth === "notDetermined" ? (
            <Button data-testid="sync-allow" disabled={busy} onClick={() => void allow()}>
              {t("sync.setup.allow")}
            </Button>
          ) : (
            <Button
              data-testid="sync-recheck"
              variant="secondary"
              disabled={busy}
              onClick={() => void recheck()}
            >
              {t("sync.setup.recheck")}
            </Button>
          )}
        </div>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="ll-label mb-2">{t("sync.setup.step2")}</legend>
            {albums === null ? (
              <SkeletonRegion label={t("common.loading")} className="flex flex-col gap-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </SkeletonRegion>
            ) : albums.length === 0 ? (
              <p className="text-muted">{t("sync.setup.noAlbums")}</p>
            ) : (
              <ul className="ll-list max-h-64 overflow-y-auto" data-testid="sync-albums">
                {albums.map((a) => (
                  <li key={a.id} className="!p-0">
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 px-4">
                      <input
                        type="radio"
                        name="sync-album"
                        checked={albumId === a.id}
                        onChange={() => setAlbumId(a.id)}
                      />
                      <span className="min-w-0 flex-1 truncate">{a.title}</span>
                      <span className="text-sm text-muted">
                        {t("sync.setup.albumCount", { n: formatCount(a.count) })}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          {adminBabies.length > 1 ? (
            <SelectField
              label={t("sync.setup.baby")}
              data-testid="sync-baby"
              value={babyId}
              onChange={(e) => setBabyId(e.target.value)}
            >
              {adminBabies.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nickname ?? b.name}
                </option>
              ))}
            </SelectField>
          ) : null}

          <div className="flex flex-col gap-1">
            <CheckField
              data-testid="sync-wifi"
              label={t("sync.wifiOnly")}
              checked={wifiOnly}
              onChange={(e) => setWifiOnly(e.target.checked)}
            />
            <p className="ll-hint">{t("sync.wifiOnlyHint")}</p>
          </div>

          {error ? <Message data-testid="sync-setup-error">{error}</Message> : null}
          <Button
            data-testid="sync-start"
            disabled={busy || !albumId || !babyId}
            onClick={() => void start()}
          >
            {t("sync.setup.start")}
          </Button>
        </>
      )}
      <Button variant="link" data-testid="sync-setup-cancel" onClick={onDone}>
        {t("common.cancel")}
      </Button>
    </div>
  );
}

/** Set-up sheet (iPhone, admins). Step 1 is where the Photos permission prompt can appear. */
export function SetupSyncSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <IonModal isOpen={open} onDidDismiss={onClose} className="ll-sheet">
      {open ? <SetupBody onDone={onClose} /> : null}
    </IonModal>
  );
}
