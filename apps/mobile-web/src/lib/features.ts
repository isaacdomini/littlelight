/**
 * Build-time feature gates for surfaces whose server side lands in a later step. The server
 * remains the real enforcement; these only decide whether the UI offers an entry point.
 * Step 8 turned `sharing` on; `chat` (step 7) and `aiEdits` (step 6) are on.
 */
export const FEATURES = { sharing: true, chat: true, aiEdits: true } as const;
