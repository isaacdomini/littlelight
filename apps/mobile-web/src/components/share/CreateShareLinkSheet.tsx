import { IonModal } from "@ionic/react";
import {
  SHARE_LINK_DEFAULT_TTL_HOURS,
  SHARE_LINK_TTL_CHOICES_HOURS,
  SHARE_PASSCODE_LENGTH,
  type ShareLinkCreatedResponse,
} from "@littlelight/shared";
import { useState } from "react";
import { t } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { useCreateShareLink } from "../../lib/queries/sharing";
import { Button, CheckField, Message, TextField } from "../ui";
import { EMPTY_RULE, type RuleDraft, RuleEditor, ruleInput } from "./RuleEditor";

const PASSCODE_RE = new RegExp(`^\\d{${SHARE_PASSCODE_LENGTH}}$`);
const SUGGESTIONS = ["share.create.suggestion0", "share.create.suggestion1"] as const;

/** Create form (name, duration, optional passcode, downloads, auto-share rule). */
export function CreateShareLinkForm({
  babyId,
  plus,
  onCreated,
  onCancel,
}: {
  babyId: string;
  plus: boolean;
  onCreated: (created: ShareLinkCreatedResponse) => void;
  onCancel: () => void;
}) {
  const create = useCreateShareLink(babyId);
  const [name, setName] = useState("");
  const [ttl, setTtl] = useState<number>(SHARE_LINK_DEFAULT_TTL_HOURS);
  const [passcode, setPasscode] = useState("");
  const [download, setDownload] = useState(false);
  const [rule, setRule] = useState<RuleDraft>(EMPTY_RULE);
  const [error, setError] = useState<string | null>(null);

  const passcodeBad = passcode !== "" && !PASSCODE_RE.test(passcode);
  const rulePayload = ruleInput(rule);
  const canSubmit = name.trim() !== "" && !passcodeBad && rulePayload !== undefined;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        ttlHours: ttl,
        passcode: passcode === "" ? null : passcode,
        allowDownload: download,
        rule: plus ? rulePayload : null,
      });
      onCreated(created);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <form
      data-testid="share-create"
      className="flex max-h-[90vh] flex-col gap-5 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h2 className="text-xl font-semibold">{t("share.create.title")}</h2>
      <div className="flex flex-col gap-2">
        <TextField
          data-testid="share-name"
          label={t("share.create.name")}
          hint={t("share.create.nameHint")}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <ul className="ll-chips !py-0">
          {SUGGESTIONS.map((k) => (
            <li key={k}>
              <button type="button" className="ll-chip" onClick={() => setName(t(k))}>
                {t(k)}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="ll-label mb-1">{t("share.create.duration")}</legend>
        <div className="ll-chips">
          {SHARE_LINK_TTL_CHOICES_HOURS.map((h) => (
            <button
              key={h}
              type="button"
              aria-pressed={ttl === h}
              data-testid={`share-ttl-${h}`}
              className="ll-chip"
              onClick={() => setTtl(h)}
            >
              {t(`share.ttl.${h}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <TextField
        data-testid="share-passcode-input"
        label={t("share.create.passcode")}
        hint={passcodeBad ? t("share.create.passcodeBad") : t("share.create.passcodeHint")}
        inputMode="numeric"
        autoComplete="off"
        maxLength={SHARE_PASSCODE_LENGTH}
        value={passcode}
        onChange={(e) => setPasscode(e.target.value.replace(/\D/g, ""))}
      />
      <div>
        <CheckField
          data-testid="share-allow-download"
          label={t("share.create.download")}
          checked={download}
          onChange={(e) => setDownload(e.target.checked)}
        />
        <p className="ll-hint pl-9">{t("share.create.downloadHint")}</p>
      </div>
      <RuleEditor babyId={babyId} plus={plus} value={rule} onChange={setRule} />
      {error ? <Message data-testid="share-create-error">{error}</Message> : null}
      <div className="flex gap-3">
        <Button
          type="submit"
          className="flex-1"
          data-testid="share-create-submit"
          disabled={!canSubmit || create.isPending}
        >
          {t("share.create.submit")}
        </Button>
        <Button variant="secondary" data-testid="share-create-cancel" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

export function CreateShareLinkSheet({
  open,
  babyId,
  plus,
  onCreated,
  onClose,
}: {
  open: boolean;
  babyId: string;
  plus: boolean;
  onCreated: (created: ShareLinkCreatedResponse) => void;
  onClose: () => void;
}) {
  return (
    <IonModal isOpen={open} onDidDismiss={onClose} className="ll-sheet">
      {open ? (
        <CreateShareLinkForm babyId={babyId} plus={plus} onCreated={onCreated} onCancel={onClose} />
      ) : null}
    </IonModal>
  );
}
