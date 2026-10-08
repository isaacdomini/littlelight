import { type Baby, babyCreateSchema, babySchema } from "@littlelight/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ME_KEY, useAuth } from "../../auth/AuthProvider";
import { FlowPage } from "../../components/Page";
import { Button, CheckField, Message, TextField } from "../../components/ui";
import { t } from "../../i18n";
import { apiFetch, errorMessage } from "../../lib/api";

const today = () => new Date().toISOString().slice(0, 10);

/** Positive decimal -> integer in `factor` units, or undefined when blank/invalid. */
function toInt(value: string, factor: number): number | undefined {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * factor) : undefined;
}

export function BabyPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const another = params.get("another") === "1";
  const { me, refetchMe, setCurrentBabyId } = useAuth();
  const imperial = me?.profile?.units === "imperial";
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [dueDate, setDueDate] = useState(false);
  const [weight, setWeight] = useState("");
  const [length, setLength] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const input = babyCreateSchema.safeParse({
      name,
      birthDate,
      birthDateIsDueDate: dueDate,
      birthWeightG: toInt(weight, imperial ? 453.592 : 1000),
      birthLengthMm: toInt(length, imperial ? 25.4 : 10),
    });
    if (!input.success) {
      setError(t("common.genericError"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const baby: Baby = await apiFetch("/babies", {
        method: "POST",
        body: input.data,
        schema: babySchema,
      });
      await qc.invalidateQueries({ queryKey: ME_KEY });
      await refetchMe();
      setCurrentBabyId(baby.id);
      navigate(another ? "/timeline" : "/onboarding/invite", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowPage title={another ? t("baby.titleAnother") : t("baby.title")} testId="baby">
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
        <TextField
          data-testid="baby-name"
          label={t("baby.nameLabel")}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <CheckField
          data-testid="baby-due-toggle"
          label={t("baby.notBornYet")}
          checked={dueDate}
          onChange={(e) => setDueDate(e.target.checked)}
        />
        <TextField
          data-testid="baby-birthdate"
          label={dueDate ? t("baby.dueDate") : t("baby.birthDate")}
          type="date"
          max={dueDate ? undefined : today()}
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
        />
        <TextField
          data-testid="baby-weight"
          label={`${imperial ? t("baby.weightLb") : t("baby.weightKg")} (${t("common.optional")})`}
          inputMode="decimal"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
        />
        <TextField
          data-testid="baby-length"
          label={`${imperial ? t("baby.lengthIn") : t("baby.lengthCm")} (${t("common.optional")})`}
          inputMode="decimal"
          value={length}
          onChange={(e) => setLength(e.target.value)}
        />
        <p className="text-sm opacity-70">{t("baby.photoLater")}</p>
        {error ? <Message data-testid="baby-error">{error}</Message> : null}
        <Button
          type="submit"
          data-testid="baby-create"
          disabled={busy || name.trim() === "" || birthDate === ""}
        >
          {t("baby.create")}
        </Button>
      </form>
    </FlowPage>
  );
}
