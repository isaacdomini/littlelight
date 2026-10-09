import { IonModal } from "@ionic/react";
import {
  SHARE_LINK_TTL_CHOICES_HOURS,
  SHARE_PASSCODE_LENGTH,
  type ShareLink,
} from "@littlelight/shared";
import { useState } from "react";
import { t } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { usePatchShareLink, useRemoveShareRule, useSaveShareRule } from "../../lib/queries/sharing";
import { Button, CheckField, Message, TextField } from "../ui";
import { EMPTY_RULE, type RuleDraft, RuleEditor, ruleInput } from "./RuleEditor";

const PASSCODE_RE = new RegExp(`^\\d{${SHARE_PASSCODE_LENGTH}}$`);

function draftOf(link: ShareLink): RuleDraft {
  return link.rule
    ? {
        mode: link.rule.mode,
        includeTags: link.rule.includeTags,
        excludeTags: link.rule.excludeTags,
      }
    : EMPTY_RULE;
}

function SettingsForm({
  link,
  plus,
  onClose,
}: {
  link: ShareLink;
  plus: boolean;
  onClose: () => void;
}) {
  const patch = usePatchShareLink(link.babyId);
  const saveRule = useSaveShareRule(link.babyId);
  const removeRule = useRemoveShareRule(link.babyId);
  const [name, setName] = useState(link.name);
  const [ttl, setTtl] = useState(link.ttlHours);
  const [download, setDownload] = useState(link.allowDownload);
  const [passcodeMode, setPasscodeMode] = useState<"keep" | "change" | "clear">("keep");
  const [passcode, setPasscode] = useState("");
  const [rule, setRule] = useState<RuleDraft>(draftOf(link));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const settingPasscode = link.hasPasscode ? passcodeMode === "change" : passcode !== "";
  const passcodeBad = settingPasscode && !PASSCODE_RE.test(passcode);
  const rulePayload = ruleInput(rule);
  const hadRule = link.rule !== null;
  const canSave = name.trim() !== "" && !passcodeBad && (!plus || rulePayload !== undefined);

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const body: Parameters<typeof patch.mutateAsync>[0] = { id: link.id };
      if (name.trim() !== link.name) body.name = name.trim();
      if (download !== link.allowDownload) body.allowDownload = download;
      if (ttl !== link.ttlHours) body.ttlHours = ttl;
      if (settingPasscode) body.passcode = passcode;
      if (passcodeMode === "clear") body.passcode = null;
      if (Object.keys(body).length > 1) await patch.mutateAsync(body);
      if (plus) {
        if (rulePayload && JSON.stringify(rulePayload) !== JSON.stringify(rulePart(link))) {
          await saveRule.mutateAsync({ id: link.id, rule: rulePayload });
        } else if (rulePayload === null && hadRule) {
          await removeRule.mutateAsync(link.id);
        }
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <form
      data-testid="share-settings"
      className="flex max-h-[90vh] flex-col gap-5 overflow-y-auto p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      noValidate
    >
      <h2 className="text-xl font-semibold">{t("share.settings.title")}</h2>
      <TextField
        data-testid="share-settings-name"
        label={t("share.create.name")}
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="ll-label mb-1">{t("share.settings.duration")}</legend>
        <div className="ll-chips">
          {SHARE_LINK_TTL_CHOICES_HOURS.map((h) => (
            <button
              key={h}
              type="button"
              aria-pressed={ttl === h}
              data-testid={`share-settings-ttl-${h}`}
              className="ll-chip"
              onClick={() => setTtl(h)}
            >
              {t(`share.ttl.${h}`)}
            </button>
          ))}
        </div>
        <p className="ll-hint">{t("share.settings.durationHint")}</p>
      </fieldset>
      <div className="flex flex-col gap-2">
        <p className="ll-label">{t("share.create.passcode")}</p>
        {link.hasPasscode && passcodeMode !== "change" ? (
          <p className="ll-hint">
            {passcodeMode === "clear"
              ? t("share.settings.passcodeRemoved")
              : t("share.settings.passcodeOn")}
          </p>
        ) : null}
        {passcodeMode === "change" || !link.hasPasscode ? (
          <TextField
            data-testid="share-settings-passcode"
            label={t("share.settings.newPasscode")}
            hideLabel
            hint={passcodeBad ? t("share.create.passcodeBad") : t("share.create.passcodeHint")}
            inputMode="numeric"
            autoComplete="off"
            maxLength={SHARE_PASSCODE_LENGTH}
            value={passcode}
            onChange={(e) => setPasscode(e.target.value.replace(/\D/g, ""))}
          />
        ) : null}
        {link.hasPasscode ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              data-testid="share-settings-passcode-change"
              onClick={() => setPasscodeMode(passcodeMode === "change" ? "keep" : "change")}
            >
              {t("share.settings.changePasscode")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="share-settings-passcode-clear"
              onClick={() => setPasscodeMode(passcodeMode === "clear" ? "keep" : "clear")}
            >
              {passcodeMode === "clear" ? t("common.cancel") : t("share.settings.removePasscode")}
            </Button>
          </div>
        ) : null}
        {link.hasPasscode ? <p className="ll-caption">{t("share.settings.passcodeNote")}</p> : null}
      </div>
      <CheckField
        data-testid="share-settings-download"
        label={t("share.create.download")}
        checked={download}
        onChange={(e) => setDownload(e.target.checked)}
      />
      <RuleEditor babyId={link.babyId} plus={plus} value={rule} onChange={setRule} />
      {error ? <Message data-testid="share-settings-error">{error}</Message> : null}
      <div className="flex gap-3">
        <Button
          type="submit"
          className="flex-1"
          data-testid="share-settings-save"
          disabled={!canSave || busy}
        >
          {t("common.save")}
        </Button>
        <Button variant="secondary" data-testid="share-settings-cancel" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

function rulePart(link: ShareLink) {
  return link.rule
    ? {
        mode: link.rule.mode,
        includeTags: link.rule.includeTags,
        excludeTags: link.rule.excludeTags,
      }
    : null;
}

export function ShareLinkSettingsSheet({
  link,
  plus,
  onClose,
}: {
  /** `null` = closed. */
  link: ShareLink | null;
  plus: boolean;
  onClose: () => void;
}) {
  return (
    <IonModal isOpen={link !== null} onDidDismiss={onClose} className="ll-sheet">
      {link ? <SettingsForm key={link.id} link={link} plus={plus} onClose={onClose} /> : null}
    </IonModal>
  );
}
