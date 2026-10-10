// Compatibility shim: the query hooks live in `./queries/*` (step 5 split). Existing imports of
// `lib/queries` keep working.
export * from "./queries/account";
export * from "./queries/ai";
export * from "./queries/exports";
export * from "./queries/measurements";
export * from "./queries/milestones";
export * from "./queries/photos";
