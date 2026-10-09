import { FlowPage } from "../../components/Page";
import { Button } from "../../components/ui";
import { t } from "../../i18n";
import { isNative } from "../../platform/platform";

/**
 * `/signin/native`: the app-claimed return path for a native-initiated browser sign-in (9b).
 * On the web it explains where the link belongs; in the app it is a placeholder until 9b
 * (Apple/Google on native); email codes are the only sign-in for now. The URL's query and
 * fragment are never read, logged or stored here.
 */
export function NativeSignInPage() {
  const native = isNative();
  return (
    <FlowPage
      title={t("native.signin.title")}
      subtitle={native ? t("native.signin.appBody") : t("native.signin.webBody")}
      testId="native-signin"
    >
      <Button
        variant={native ? "primary" : "secondary"}
        data-testid="native-signin-back"
        onClick={() => window.location.replace("/welcome")}
      >
        {t("native.signin.back")}
      </Button>
    </FlowPage>
  );
}
