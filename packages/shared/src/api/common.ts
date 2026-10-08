import { z } from "zod";

// Wire conventions for API DTOs (docs/plans/step-3.md 2.6). Request schemas are plain
// `z.object`s: unknown keys are stripped, so handlers only ever see declared fields. Response
// schemas also strip, so a row with extra columns cannot leak through serialization.
//
// - Timestamps are ISO 8601 strings with an offset (`Date#toISOString()` output qualifies).
// - Calendar dates (e.g. a birth date) are `YYYY-MM-DD` strings, never Date objects.

/** A timestamp on the wire: `2026-10-08T12:34:56.000Z`. Convert DB `Date`s with `toISOString()`. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
/** A calendar date on the wire: `2025-06-30`. */
export const isoDateSchema = z.iso.date();

/** Route params `{ id }` (e.g. `/babies/:id`, `/auth/sessions/:id`). */
export const idParamsSchema = z.object({ id: z.uuid() });
export type IdParams = z.infer<typeof idParamsSchema>;
