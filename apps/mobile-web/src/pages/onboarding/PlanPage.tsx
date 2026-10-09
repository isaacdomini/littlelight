import { PLUS_PRICE_USD_MONTHLY } from "@littlelight/shared";
import { useNavigate } from "react-router-dom";
import { FlowPage } from "../../components/Page";
import { Button, Card } from "../../components/ui";
import { t } from "../../i18n";

/** Plan step. Upgrade is UI only in step 3: payments arrive with billing (RevenueCat/Stripe). */
export function PlanPage() {
  const navigate = useNavigate();
  return (
    <FlowPage title={t("plan.title")} testId="plan">
      <Card>
        <h2 className="text-lg font-semibold">{t("plan.free.name")}</h2>
        <p className="mb-4 text-muted">{t("plan.free.body")}</p>
        <Button
          data-testid="plan-skip"
          className="w-full"
          onClick={() => navigate("/onboarding/first-upload", { replace: true })}
        >
          {t("plan.free.cta")}
        </Button>
      </Card>
      <Card>
        <h2 className="text-lg font-semibold">
          {t("plan.plus.price", { price: `$${PLUS_PRICE_USD_MONTHLY.toFixed(2)}` })}
        </h2>
        <p className="mb-4 text-muted">{t("plan.plus.body")}</p>
        <Button variant="secondary" data-testid="plan-upgrade" className="w-full" disabled>
          {t("plan.plus.cta")}
        </Button>
      </Card>
    </FlowPage>
  );
}
