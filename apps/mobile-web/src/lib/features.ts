/**
 * Build-time feature gates for surfaces whose server side lands in a later step. The server
 * remains the real enforcement; these only decide whether the UI offers an entry point.
 * Step 8 flips `sharing`, step 7 `chat`, step 6 `aiEdits`.
 */
export const FEATURES = { sharing: false, chat: false, aiEdits: true } as const;
