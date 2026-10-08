import { t } from "../i18n";

/** Desktop left pane. Chat arrives with search (step 7); gated by `FEATURES.chat` there. */
export function ChatPanePlaceholder() {
  return (
    <section
      className="flex h-full flex-col gap-2 p-4"
      aria-label={t("tabs.chat")}
      data-testid="chat-pane-placeholder"
    >
      <h2 className="text-lg font-semibold">{t("tabs.chat")}</h2>
      <p className="text-sm opacity-70">{t("chat.placeholder")}</p>
    </section>
  );
}
