import { PRIVACY_VERSION, TERMS_VERSION } from "@littlelight/shared";
import { SubPage } from "../components/Page";
import { t } from "../i18n";

/** Placeholder legal pages (real copy is a launch task, plan D11). */
export function LegalPage({ kind }: { kind: "terms" | "privacy" }) {
  const terms = kind === "terms";
  return (
    <SubPage title={t(terms ? "legal.terms" : "legal.privacy")} backHref="/onboarding/consent">
      <p>{t("legal.placeholder")}</p>
      <p className="text-sm opacity-70">
        {t("legal.version", { version: terms ? TERMS_VERSION : PRIVACY_VERSION })}
      </p>
    </SubPage>
  );
}
