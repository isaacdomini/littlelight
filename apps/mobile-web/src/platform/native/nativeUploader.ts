import { type PluginListenerHandle, registerPlugin } from "@capacitor/core";
import {
  type NativeFileRef,
  PartUploadError,
  type PartUploadReason,
  type PutPartOptions,
  type Uploader,
  webUploader,
} from "../uploader";

// Native background uploader adapter (docs/plans/step-9.md 2.6; ranged parts: step 12, NATIVE.md
// "Uploads") over the in-house `TinyglowUploader` plugin. One `upload()` is one part: a raw-body
// PUT of the byte range `offset..offset+length` of a file to the presigned URL, no multipart and
// no extra headers (the URL signs none). The OS continues the transfer while the app is
// suspended; the promise settles when the app is running again.
// URLs carry `X-Amz-Signature` and paths are private: nothing here is ever logged.

interface TinyglowUploaderPlugin {
  upload(opts: {
    url: string;
    path: string;
    offset?: number;
    length?: number;
    wifiOnly?: boolean;
  }): Promise<{ id: string }>;
  cancel(opts: { id: string }): Promise<void>;
  /** iOS: part copies still on disk; Android: always 0. */
  pendingParts(): Promise<{ count: number }>;
  addListener(
    event: "progress",
    cb: (e: { id: string; sent: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "done",
    cb: (e: { id: string; status: number }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "error",
    cb: (e: { id: string; message: string }) => void,
  ): Promise<PluginListenerHandle>;
}

type PluginEvent =
  | { name: "progress"; id: string; sent: number }
  | { name: "done"; id: string; status: number }
  | { name: "error"; id: string };

interface Pending {
  opts: PutPartOptions;
  resolve: () => void;
  reject: (e: unknown) => void;
}

const pending = new Map<string, Pending>();
// Events that arrive before `upload()` has returned its id.
const early = new Map<string, PluginEvent[]>();
let plugin: TinyglowUploaderPlugin | null = null;
let listening: Promise<unknown> | null = null;

function refusalReason(e: unknown): PartUploadReason | null {
  const err = e as { code?: unknown; message?: unknown } | null;
  for (const v of [err?.code, err?.message]) {
    if (v === "no-space" || v === "bad-range") return v;
  }
  return null;
}

function settle(ev: PluginEvent) {
  const p = pending.get(ev.id);
  if (!p) {
    if (ev.name === "progress") return;
    const list = early.get(ev.id) ?? [];
    list.push(ev);
    early.set(ev.id, list);
    return;
  }
  if (ev.name === "progress") {
    p.opts.onProgress?.(ev.sent);
    return;
  }
  pending.delete(ev.id);
  if (ev.name === "done" && ev.status >= 200 && ev.status < 300) p.resolve();
  else p.reject(new PartUploadError(ev.name === "done" ? ev.status : 0));
}

// Resolves with a wrapper, never with the plugin: a Capacitor plugin is a Proxy whose `then` is a
// (non-existent) native method, so resolving a promise with it never settles.
async function load(): Promise<{ uploader: TinyglowUploaderPlugin }> {
  plugin ??= registerPlugin<TinyglowUploaderPlugin>("TinyglowUploader");
  const u = plugin;
  listening ??= Promise.all([
    u.addListener("progress", (e) => settle({ name: "progress", id: e.id, sent: e.sent })),
    u.addListener("done", (e) => settle({ name: "done", id: e.id, status: e.status })),
    u.addListener("error", (e) => settle({ name: "error", id: e.id })),
  ]);
  await listening;
  return { uploader: u };
}

async function putFile(url: string, file: NativeFileRef, opts: PutPartOptions = {}): Promise<void> {
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const { uploader } = await load();
  let id: string;
  try {
    ({ id } = await uploader.upload({
      url,
      path: file.path,
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      ...(opts.length !== undefined ? { length: opts.length } : {}),
      ...(opts.wifiOnly ? { wifiOnly: true } : {}),
    }));
  } catch (e) {
    // `no-space` / `bad-range` are the plugin's own refusals (message = code, nothing from the
    // OS): no retry can fix them, so they surface as such. Everything else is a transport error.
    throw new PartUploadError(0, refusalReason(e));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id);
      early.delete(id);
      void uploader.cancel({ id }).catch(() => undefined);
      reject(new DOMException("Aborted", "AbortError"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = <T extends (...a: never[]) => void>(fn: T) =>
      ((...a: Parameters<T>) => {
        opts.signal?.removeEventListener("abort", onAbort);
        fn(...a);
      }) as T;
    pending.set(id, { opts, resolve: done(resolve), reject: done(reject) });
    for (const ev of early.get(id) ?? []) settle(ev);
    early.delete(id);
  });
}

/** Ranged part copies the iOS plugin still holds (a sweep signal; 0 on Android). */
export async function pendingParts(): Promise<number> {
  try {
    const { uploader } = await load();
    return (await uploader.pendingParts()).count;
  } catch {
    return 0;
  }
}

export const nativeUploader: Uploader = {
  // Blob parts only reach this on a web-style upload without a file reference (never for
  // picked/synced files: the manager sends every part of those through `putFile` with a range).
  putPart: (url, blob, opts) => webUploader.putPart(url, blob, opts),
  putFile,
};
