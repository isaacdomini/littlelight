import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../../auth/AuthProvider";
import { FlowPage } from "../../components/Page";
import { Button } from "../../components/ui";
import { t } from "../../i18n";
import { markOnboardingDone } from "../../lib/session";
import { isNative } from "../../platform/platform";

/** Permission primer (PRD sign-up step 8); the picker itself is on the Upload screen. */
export function FirstUploadPage() {
  const navigate = useNavigate();
  const { baby } = useCurrentBaby();
  const finish = (to: string) => {
    if (baby) markOnboardingDone(baby.id);
    navigate(to, { replace: true });
  };
  return (
    <FlowPage
      title={t("primer.title")}
      subtitle={isNative() ? t("native.primer.body") : t("primer.body")}
      testId="primer"
    >
      <Button data-testid="primer-continue" onClick={() => finish("/upload")}>
        {t("primer.choose")}
      </Button>
      <Button variant="link" data-testid="primer-later" onClick={() => finish("/timeline")}>
        {t("primer.later")}
      </Button>
    </FlowPage>
  );
}
