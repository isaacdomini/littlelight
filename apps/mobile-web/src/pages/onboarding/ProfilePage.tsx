import { useQueryClient } from "@tanstack/react-query";
import {
  type MeResponse,
  meResponseSchema,
  profileUpdateSchema,
  RELATIONSHIP_LABELS,
  type Units,
} from "@tinyglow/shared";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ME_KEY, useAuth } from "../../auth/AuthProvider";
import { nextOnboardingRoute } from "../../auth/onboarding";
import { FlowPage } from "../../components/Page";
import { Button, Message, SelectField, TextField } from "../../components/ui";
import { t } from "../../i18n";
import { apiFetch, errorMessage } from "../../lib/api";
import { pendingInvite } from "../../lib/session";

function detectTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [detectTimezone()];
  }
}

export function ProfilePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const profile = me?.profile ?? null;
  const [name, setName] = useState(profile?.displayName ?? "");
  const [label, setLabel] = useState(profile?.relationshipLabel ?? "");
  const [tz, setTz] = useState(detectTimezone());
  const [units, setUnits] = useState<Units>(profile?.units ?? "metric");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = {
      displayName: name,
      ...(label.trim() ? { relationshipLabel: label } : {}),
      timezone: tz,
      units,
    };
    const check = profileUpdateSchema.safeParse(body);
    if (!check.success) {
      setError(t("common.genericError"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await apiFetch<MeResponse>("/me/profile", {
        method: "PATCH",
        body: check.data,
        schema: meResponseSchema,
      });
      qc.setQueryData(ME_KEY, updated);
      navigate(nextOnboardingRoute(updated, pendingInvite.get()), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isPreset = (RELATIONSHIP_LABELS as readonly string[]).includes(label);

  return (
    <FlowPage title={t("profile.title")} testId="profile">
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-6" noValidate>
        <TextField
          data-testid="profile-name"
          label={t("profile.nameLabel")}
          autoComplete="name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="ll-label mb-1">{t("profile.relationship")}</legend>
          <div className="ll-chips">
            {RELATIONSHIP_LABELS.map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={label === l}
                data-testid={`profile-rel-${l.toLowerCase()}`}
                onClick={() => setLabel(l)}
                className="ll-chip"
              >
                {l}
              </button>
            ))}
          </div>
          <TextField
            label={t("profile.relationshipOther")}
            maxLength={40}
            value={isPreset ? "" : label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </fieldset>
        <SelectField
          id="profile-tz"
          label={t("profile.timezone")}
          value={tz}
          onChange={(e) => setTz(e.target.value)}
        >
          {[...new Set([tz, ...timezones()])].map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </SelectField>
        <fieldset className="flex flex-col">
          <legend className="ll-label mb-1">{t("profile.units")}</legend>
          {(["metric", "imperial"] as const).map((u) => (
            <label key={u} className="ll-check !items-center">
              <input type="radio" name="units" checked={units === u} onChange={() => setUnits(u)} />
              {t(u === "metric" ? "profile.units.metric" : "profile.units.imperial")}
            </label>
          ))}
        </fieldset>
        {error ? <Message data-testid="profile-error">{error}</Message> : null}
        <Button type="submit" data-testid="profile-continue" disabled={busy || name.trim() === ""}>
          {t("profile.continue")}
        </Button>
      </form>
    </FlowPage>
  );
}
