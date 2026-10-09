import { CITATION_MARKER_MAX_LENGTH, type Citation, type CitationKind } from "@littlelight/shared";

// Streaming citation filter (docs/plans/step-7.md 2.8 "Agent", D5). The model cites with inline
// markers `[photo:<uuid>]` / `[measurement:<uuid>]`; the user never sees them. This transformer
// removes every marker from the streamed text as it arrives and records the citations in order,
// with exactly the removal rule of `parseCitations` in `@littlelight/shared`: a marker goes
// together with the spaces/tabs right before it, kind is case-insensitive, malformed ids are
// stripped too (counted as `invalid`), duplicates are recorded once. Text from a `[` is held back
// until the matching `]` or `CITATION_MARKER_MAX_LENGTH` characters, and trailing spaces are held
// until we know whether a marker follows, so a marker split across deltas never leaks. Whether a
// cited id may stay is decided afterwards by `partitionCitations` against the turn's tool results.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The shared marker body (without the leading whitespace), anchored at a `[`. */
const MARKER_AT = /\[\s*(photo|measurement)\s*:\s*([^\]\s]{1,64})\s*\]/iy;

export interface CitationFilter {
  /** Feed a model delta; returns the clean text that can be shown now (may be ""). */
  push(delta: string): string;
  /** End of stream: returns whatever was held back (an unfinished `[…` is ordinary text). */
  flush(): string;
  /** Well-formed citations so far, first-appearance order, de-duplicated. */
  readonly citations: readonly Citation[];
  /** Markers removed whose id was not a uuid. */
  readonly invalid: number;
}

export function createCitationFilter(): CitationFilter {
  let pending = "";
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let invalid = 0;

  function record(kind: string, rawId: string): void {
    const id = rawId.toLowerCase();
    if (!UUID_RE.test(id)) {
      invalid++;
      return;
    }
    const k = kind.toLowerCase() as CitationKind;
    const key = `${k}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    citations.push({ kind: k, id });
  }

  /** Emits what is safe from `pending`; keeps a possible marker (and the spaces before it). */
  function drain(final: boolean): string {
    let out = "";
    for (;;) {
      const open = pending.indexOf("[");
      if (open < 0) {
        if (final) {
          out += pending;
          pending = "";
        } else {
          const keep = pending.length - pending.replace(/[ \t]+$/, "").length;
          out += pending.slice(0, pending.length - keep);
          pending = pending.slice(pending.length - keep);
        }
        return out;
      }
      // Text before the `[`, minus the spaces that would go with a marker.
      const before = pending.slice(0, open);
      const lead = before.length - before.replace(/[ \t]+$/, "").length;
      MARKER_AT.lastIndex = open;
      const m = MARKER_AT.exec(pending);
      if (m) {
        out += before.slice(0, before.length - lead);
        record(m[1] as string, m[2] as string);
        pending = pending.slice(open + m[0].length);
        continue;
      }
      const close = pending.indexOf("]", open);
      const undecided = close < 0 && pending.length - open < CITATION_MARKER_MAX_LENGTH;
      if (undecided && !final) {
        out += before.slice(0, before.length - lead);
        pending = pending.slice(open - lead);
        return out;
      }
      // Not a marker: emit through the `[` and keep scanning after it.
      out += pending.slice(0, open + 1);
      pending = pending.slice(open + 1);
    }
  }

  return {
    push(delta: string): string {
      pending += delta;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
    get citations() {
      return citations;
    },
    get invalid() {
      return invalid;
    },
  };
}
