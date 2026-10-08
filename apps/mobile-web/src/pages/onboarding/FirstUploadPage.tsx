import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { FlowPage } from "../../components/Page";
import { Button } from "../../components/ui";
import { t } from "../../i18n";
import { markOnboardingDone } from "../../lib/session";

/** Permission primer. The real picker arrives with the upload screen (step 4). */
export function FirstUploadPage() {
  const navigate = useNavigate();
  const { baby } = useCurrentBaby();
  const finish = (to: string) => {
    if (baby) markOnboardingDone(baby.id);
    navigate(to, { replace: true });
  };
  return (
    <FlowPage title={t("primer.title")} subtitle={t("primer.body")} testId="primer">
      <Button data-testid="primer-continue" onClick={() => finish("/upload")}>
        {t("primer.choose")}
      </Button>
      <Button variant="link" data-testid="primer-later" onClick={() => finish("/timeline")}>
        {t("primer.later")}
      </Button>
    </FlowPage>
  );
}
