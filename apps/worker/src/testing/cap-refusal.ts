import type { PipelinePool } from "../db";

// Test double for the cap triggers of migration 22 (docs/plans/step-12.md 2.3; review fix S1): a
// pool whose clients throw the exact Postgres 23514 error the trigger raises for a given statement
// text, so the worker's handling can be exercised without filling a family's pool first.

export const CAP_MESSAGES = {
  photo: "free tier photo limit reached for this family",
  video: "free tier video limit reached for this family",
  pending: "pending photo limit reached for this uploader",
} as const;

/** A pool whose clients throw a Postgres-shaped 23514 for the given statement texts. */
export function refusingPool(
  base: PipelinePool,
  refuse: Record<string, string>,
  hits: string[] = [],
): PipelinePool {
  return {
    async connect() {
      const client = await base.connect();
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === "query") {
            return (text: unknown, ...rest: unknown[]) => {
              if (typeof text === "string" && refuse[text] !== undefined) {
                hits.push(text);
                return Promise.reject(
                  Object.assign(new Error(refuse[text]), {
                    code: "23514",
                    constraint: null,
                    severity: "ERROR",
                  }),
                );
              }
              return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
}
