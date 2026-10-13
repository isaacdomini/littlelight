import { IonAlert } from "@ionic/react";
import { PASSKEY_DEFAULT_NAME, PASSKEY_NAME_MAX, type Passkey } from "@tinyglow/shared";
import { keyOutline } from "ionicons/icons";
import { type FormEvent, useState } from "react";
import { useFreshSignIn } from "../../auth/FreshSignInGate";
import { SubPage } from "../../components/Page";
import { passkeyAddError } from "../../components/passkeyErrors";
import { Button, Card, EmptyState, ListSkeleton, Message, TextField } from "../../components/ui";
import { t } from "../../i18n";
import { errorMessage, isApiError } from "../../lib/api";
import { dismissPasskeyPromptForever } from "../../lib/passkeyPrompt";
import {
  registerPasskey,
  removePasskey,
  renamePasskey,
  useInvalidatePasskeys,
  usePasskeySupport,
  usePasskeys,
} from "../../lib/passkeys";

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * Settings -> Passkeys (docs/plans/step-13.md 2.5): list (name, created, last used), add with a
 * name, rename inline, remove with confirm; removal needs a fresh sign-in (the gate re-verifies
 * and retries). The server enforces the per-account maximum (`passkey_limit { max }`), the
 * review-account refusal and the duplicate-device check; this page only shows their messages.
 */
export function PasskeysPage() {
  const support = usePasskeySupport();
  const enabled = support.enabled === true;
  const list = usePasskeys(enabled);
  const invalidate = useInvalidatePasskeys();
  const withFresh = useFreshSignIn();
  const [mode, setMode] = useState<"list" | "add">("list");
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<Passkey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const passkeys = list.data?.passkeys ?? [];
  const max = list.data?.max ?? 0;
  const full = list.data !== undefined && passkeys.length >= max;

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await registerPasskey(name.trim() || undefined);
      await dismissPasskeyPromptForever();
      await invalidate();
      setMode("list");
      setName("");
    } catch (err) {
      setError(passkeyAddError(err));
    } finally {
      setBusy(false);
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    const value = renameValue.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await renamePasskey(renaming.id, value);
      await invalidate();
      setRenaming(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Passkey) {
    setBusy(true);
    setError(null);
    try {
      await withFresh(() => removePasskey(p.id));
      await invalidate();
    } catch (err) {
      // The gate was cancelled: nothing changed, no message needed.
      if (!isApiError(err, "fresh_sign_in_required")) setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const title = t("passkey.settings.title");

  if (support.enabled === false) {
    // Feature off or unsupported here: nothing passkey-related renders (the row is hidden too).
    return (
      <SubPage title={title} backHref="/settings">
        <Message kind="info" data-testid="passkeys-unavailable">
          {t("passkey.unavailable")}
        </Message>
      </SubPage>
    );
  }

  return (
    <SubPage title={title} backHref="/settings">
      <div className="flex flex-col gap-4" data-testid="passkeys">
        <p className="text-muted">{t("passkey.settings.intro")}</p>
        {list.isError ? <Message>{errorMessage(list.error)}</Message> : null}
        {error ? <Message data-testid="passkeys-error">{error}</Message> : null}
        {notice ? <Message kind="info">{notice}</Message> : null}

        {list.isPending && enabled ? <ListSkeleton rows={2} /> : null}

        {list.data && passkeys.length === 0 && mode === "list" ? (
          <EmptyState icon={keyOutline} data-testid="passkeys-empty">
            {t("passkey.settings.empty")}
          </EmptyState>
        ) : null}

        {passkeys.length > 0 ? (
          <ul className="ll-list" data-testid="passkeys-list">
            {passkeys.map((p) => (
              <li key={p.id} data-testid={`passkey-${p.id}`}>
                {renaming?.id === p.id ? (
                  <form onSubmit={(e) => void rename(e)} className="flex flex-col gap-3">
                    <TextField
                      data-testid="passkey-rename-input"
                      label={t("passkey.settings.renameTitle")}
                      value={renameValue}
                      maxLength={PASSKEY_NAME_MAX}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        data-testid="passkey-rename-save"
                        disabled={busy || renameValue.trim() === ""}
                      >
                        {t("common.save")}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => setRenaming(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="ll-row !flex-nowrap">
                    <div className="min-w-0">
                      <p className="truncate font-semibold" data-testid="passkey-name">
                        {p.name}
                      </p>
                      <p className="text-sm text-muted">
                        {t("passkey.settings.created", { date: fmt(p.createdAt) })}
                      </p>
                      <p className="text-sm text-muted" data-testid="passkey-last-used">
                        {p.lastUsedAt
                          ? t("passkey.settings.lastUsed", { date: fmt(p.lastUsedAt) })
                          : t("passkey.settings.neverUsed")}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="link"
                        size="sm"
                        data-testid="passkey-rename"
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setRenaming(p);
                          setRenameValue(p.name);
                        }}
                      >
                        {t("passkey.settings.rename")}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        data-testid="passkey-remove"
                        disabled={busy}
                        onClick={() => setConfirmRemove(p)}
                      >
                        {t("passkey.settings.remove")}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {list.data && passkeys.length > 0 ? (
          <p className="ll-caption" data-testid="passkeys-count">
            {t("passkey.settings.limitReached", { count: passkeys.length, max })}
          </p>
        ) : null}

        {mode === "add" ? (
          <Card>
            <form onSubmit={(e) => void add(e)} className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">{t("passkey.settings.add")}</h2>
              <TextField
                data-testid="passkey-name-input"
                label={t("passkey.settings.nameLabel")}
                hint={t("passkey.settings.nameHint")}
                placeholder={PASSKEY_DEFAULT_NAME}
                value={name}
                maxLength={PASSKEY_NAME_MAX}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" data-testid="passkey-create" disabled={busy}>
                  {t("passkey.settings.create")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setMode("list");
                    setError(null);
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </form>
          </Card>
        ) : list.data ? (
          full ? (
            <Message kind="info" data-testid="passkeys-full">
              {t("passkey.settings.limit", { max })}
            </Message>
          ) : (
            <Button
              variant={passkeys.length === 0 ? "primary" : "secondary"}
              data-testid="passkeys-add"
              disabled={busy}
              onClick={() => {
                setError(null);
                setMode("add");
              }}
            >
              {t("passkey.settings.add")}
            </Button>
          )
        ) : null}
      </div>

      <IonAlert
        isOpen={confirmRemove !== null}
        header={t("passkey.settings.removeTitle")}
        message={t("passkey.settings.removeBody")}
        onDidDismiss={() => setConfirmRemove(null)}
        buttons={[
          { text: t("common.cancel"), role: "cancel" },
          {
            text: t("passkey.settings.removeConfirm"),
            role: "destructive",
            handler: () => {
              const p = confirmRemove;
              if (p) void remove(p);
            },
          },
        ]}
      />
    </SubPage>
  );
}
