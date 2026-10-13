import { spawn } from "node:child_process";

// Spawning ffmpeg / ffprobe (docs/plans/step-12.md 2.6). Every argument is a flag, a number, a
// filter expression or a local file path inside the scratch folder: never a URL (the originals
// are staged first; `assertLocalArgs` refuses anything that looks like one, and CI greps this
// folder for the web scheme name). stdout is collected for callers that read a frame or
// ffprobe's JSON;
// stderr is kept as a bounded tail and used only to classify failures (categories, never the
// text, reach a log line: ffmpeg's messages can contain file paths and tag values).

/** Longest stderr tail kept for classification (bytes). */
const STDERR_TAIL_BYTES = 16 * 1024;

export type FfmpegErrorCategory =
  | "timeout"
  | "spawn_failed"
  | "exit_nonzero"
  | "stdout_too_large"
  | "killed";

/** Category-only error (no command line, no stderr text, no paths). */
export class FfmpegError extends Error {
  readonly category: FfmpegErrorCategory;
  readonly exitCode: number | null;
  /**
   * Stderr tail, for callers that classify a failure (e.g. the HDR tone-map fallback). Never log
   * it. NON-ENUMERABLE: pg-boss serialises an error's own enumerable properties into
   * `pgboss.job.output`, and ffmpeg's messages can contain scratch paths and tag values.
   */
  declare readonly stderrTail: string;

  constructor(category: FfmpegErrorCategory, exitCode: number | null = null, stderrTail = "") {
    super(`ffmpeg: ${category}`);
    this.name = "FfmpegError";
    this.category = category;
    this.exitCode = exitCode;
    Object.defineProperty(this, "stderrTail", {
      value: stderrTail,
      enumerable: false,
      writable: false,
    });
  }
}

export interface RunOptions {
  /** Kill the process (SIGKILL after SIGTERM) after this many milliseconds. */
  timeoutMs: number;
  /** Largest stdout accepted (bytes); default 64 MiB (one 4K PNG frame fits). */
  maxStdoutBytes?: number;
  /** Abort from the outside (shutdown). */
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: Buffer;
  /** Bounded stderr tail (never logged). */
  stderrTail: string;
  ms: number;
}

/**
 * Refuse any argument that is a URL, a protocol-prefixed input (ffmpeg would fetch or open it) or
 * a stdio pipe (`pipe:` / `-`): every input and output of this worker is a file in the scratch
 * folder, so stdout only ever carries ffprobe's JSON.
 */
export function assertLocalArgs(args: readonly string[]): void {
  for (const a of args) {
    const v = a.trim().toLowerCase();
    // Any `scheme://` (web, ftp, rtmp, rtsp, …) or a protocol prefix ffmpeg would open itself.
    if (
      v === "-" ||
      /^pipe:/.test(v) ||
      /^[a-z][a-z0-9+.-]*:\/\//.test(v) ||
      /^(ftp|rtmp|rtmps|rtsp|srt|udp|tcp|tls|data|concat|subfile|hls|crypto|async|cache):/.test(v)
    ) {
      throw new FfmpegError("spawn_failed");
    }
  }
}

/**
 * Run `bin args` to completion. Resolves with stdout when the exit code is 0; throws
 * `FfmpegError` otherwise. The process gets no stdin and inherits nothing from this process's
 * environment but PATH (no credentials reach ffmpeg).
 */
export async function runProcess(
  bin: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  assertLocalArgs(args);
  const maxStdout = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
  const started = performance.now();
  return new Promise<RunResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
        windowsHide: true,
      });
    } catch {
      reject(new FfmpegError("spawn_failed"));
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let errTail = "";
    let settled = false;
    let timedOut = false;
    let tooLarge = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    let killTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > maxStdout) {
        tooLarge = true;
        kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errTail = (errTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", () => finish(() => reject(new FfmpegError("spawn_failed"))));
    child.on("close", (code, signal) => {
      finish(() => {
        if (timedOut) reject(new FfmpegError("timeout", code, errTail));
        else if (tooLarge) reject(new FfmpegError("stdout_too_large", code, errTail));
        else if (opts.signal?.aborted) reject(new FfmpegError("killed", code, errTail));
        else if (code !== 0)
          reject(new FfmpegError(signal ? "killed" : "exit_nonzero", code, errTail));
        else {
          resolve({
            stdout: Buffer.concat(out),
            stderrTail: errTail,
            ms: Math.round(performance.now() - started),
          });
        }
      });
    });
  });
}
