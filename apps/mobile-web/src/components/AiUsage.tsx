import { t } from "../i18n";
import { useAiUsage } from "../lib/queries/ai";
import { isNative } from "../platform/platform";

const usd = (n: number) => n.toFixed(2);

/** Admin-only "AI usage this month" line (FR-5): cost vs budget, described and in-flight counts. */
export function AiUsage({ babyId, paid }: { babyId: string; paid: boolean }) {
  const usage = useAiUsage(babyId, paid);
  const d = usage.data;
  let line: string | null = null;
  if (d) {
    const active = d.photos.queued + d.photos.analyzing;
    line = t("ai.usageLine", {
      cost: `$${usd(d.costUsd)}`,
      budget: `$${usd(d.budgetUsd)}`,
      done: d.photos.ready,
      active,
    });
    if (d.photos.failed > 0) line += ` · ${t("ai.usageFailed", { n: d.photos.failed })}`;
  }
  if (!paid && isNative()) return null;
  return (
    <section
      aria-labelledby="ai-usage-h"
      className="ll-card flex flex-col gap-2"
      data-testid="ai-usage-section"
    >
      <h2 id="ai-usage-h" className="text-xl font-semibold">
        {t("ai.usageTitle")}
      </h2>
      {!paid ? (
        <p data-testid="ai-usage">{t("ai.usageFree")}</p>
      ) : usage.isError ? (
        <p role="alert" className="ll-msg-error">
          {t("ai.usageError")}
        </p>
      ) : (
        <p data-testid="ai-usage" aria-live="polite">
          {line ?? t("common.loading")}
        </p>
      )}
      <p className="text-sm text-muted">{t("ai.usageNote")}</p>
    </section>
  );
}
