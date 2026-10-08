import { en } from "./en";

export type MessageKey = keyof typeof en;

/** Tiny localization seam: `t("key", { name })` replaces `{name}` placeholders. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template: string = en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}
