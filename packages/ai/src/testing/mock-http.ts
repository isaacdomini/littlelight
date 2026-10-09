/**
 * Shared plumbing for the in-process provider mock servers (tests and local verification only;
 * never imported by runtime code). Binds to 127.0.0.1 on a random port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  /** Lowercased header names. */
  headers: Record<string, string>;
  /** Parsed JSON body (undefined for non-JSON bodies). */
  body: unknown;
  bodyBytes: number;
  /** Multipart uploads: the form fields (file content as text). */
  form?: {
    purpose: string | null;
    filename: string | null;
    content: string | null;
    contentType: string | null;
  };
}

/** Inject an HTTP error for the next `times` matching requests (retry tests). */
export interface InjectedFailure {
  method: string;
  /** Exact path or a RegExp. */
  path: string | RegExp;
  status: number;
  times: number;
  /** Error body; default `{error: {type, code}}` from the status. */
  body?: unknown;
  /** Seconds, sent as `retry-after`. */
  retryAfter?: number;
}

export type Handler = (
  req: RecordedRequest,
  raw: { bytes: Buffer },
) => Promise<MockReply> | MockReply;

export type MockReply =
  | { status: number; json: unknown }
  | { status: number; text: string; contentType?: string };

export interface MockServerBase {
  baseUrl: string;
  requests: RecordedRequest[];
  injectFailure(f: InjectedFailure): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, reply: MockReply, extraHeaders: Record<string, string> = {}) {
  if ("json" in reply) {
    const body = JSON.stringify(reply.json);
    res.writeHead(reply.status, { "content-type": "application/json", ...extraHeaders });
    res.end(body);
    return;
  }
  res.writeHead(reply.status, {
    "content-type": reply.contentType ?? "text/plain",
    ...extraHeaders,
  });
  // Stream in small chunks so line splitting across chunk boundaries is exercised.
  const buf = Buffer.from(reply.text, "utf8");
  for (let i = 0; i < buf.length; i += 97) res.write(buf.subarray(i, i + 97));
  res.end();
}

export function defaultErrorBody(status: number) {
  const type =
    status === 429
      ? "rate_limit_error"
      : status === 404
        ? "not_found_error"
        : status >= 500
          ? "api_error"
          : "invalid_request_error";
  const code = status === 429 ? "rate_limit_exceeded" : status >= 500 ? "server_error" : null;
  return { error: { message: "mock error", type, code } };
}

export async function startMockServer(handler: Handler): Promise<MockServerBase> {
  const requests: RecordedRequest[] = [];
  const failures: InjectedFailure[] = [];
  const server = createServer(async (req, res) => {
    try {
      const bytes = await readBody(req);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        headers,
        body: undefined,
        bodyBytes: bytes.length,
      };
      const ct = headers["content-type"] ?? "";
      if (ct.startsWith("application/json") && bytes.length) {
        try {
          recorded.body = JSON.parse(bytes.toString("utf8"));
        } catch {
          recorded.body = undefined;
        }
      } else if (ct.startsWith("multipart/form-data")) {
        const form = await new Request("http://127.0.0.1/", {
          method: "POST",
          headers: { "content-type": ct },
          body: bytes,
        }).formData();
        const file = form.get("file");
        recorded.form = {
          purpose: typeof form.get("purpose") === "string" ? (form.get("purpose") as string) : null,
          filename: file instanceof Blob && "name" in file ? String((file as File).name) : null,
          content: file instanceof Blob ? await file.text() : null,
          contentType: file instanceof Blob ? file.type : null,
        };
      }
      requests.push(recorded);
      const failure = failures.find(
        (f) =>
          f.times > 0 &&
          f.method === recorded.method &&
          (typeof f.path === "string" ? f.path === recorded.path : f.path.test(recorded.path)),
      );
      if (failure) {
        failure.times--;
        send(
          res,
          { status: failure.status, json: failure.body ?? defaultErrorBody(failure.status) },
          failure.retryAfter !== undefined ? { "retry-after": String(failure.retryAfter) } : {},
        );
        return;
      }
      send(res, await handler(recorded, { bytes }));
    } catch {
      send(res, { status: 500, json: defaultErrorBody(500) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    injectFailure: (f) => failures.push({ ...f }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
