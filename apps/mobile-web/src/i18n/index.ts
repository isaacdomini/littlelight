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

type PluralBase<K> = K extends `${infer B}.one` ? B : never;
export type PluralKey = PluralBase<MessageKey>;

/** Plural lookup: `tn("timeline.photoCount", 3)` picks `.one` for 1, else `.other`; `{n}` is set. */
export function tn(base: PluralKey, n: number, vars?: Record<string, string | number>): string {
  const key = `${base}.${n === 1 ? "one" : "other"}` as MessageKey;
  return t(key, { ...vars, n });
}
