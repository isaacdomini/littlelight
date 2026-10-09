import { describe, expect, it } from "vitest";
import { loggerOptions } from "./app";

describe("loggerOptions (step 7): chat messages and search queries are parent content", () => {
  const opts = loggerOptions({ LOG_LEVEL: "info", NODE_ENV: "production" });

  it("redacts the message and query paths", () => {
    for (const path of ["req.body.text", "req.body.content", "req.body.question", "req.query.q"]) {
      expect(opts.redact.paths).toContain(path);
    }
  });

  it("the request serializer never carries the search query string or the chat body", () => {
    const search = opts.serializers.req({
      method: "GET",
      url: "/babies/11111111-1111-4111-8111-111111111111/search?q=SECRET-QUESTION&person=Grandma",
      routeOptions: { url: "/babies/:id/search" },
    });
    expect(JSON.stringify(search)).not.toMatch(/SECRET-QUESTION|Grandma/);
    expect(Object.keys(search).sort()).toEqual(["method", "route", "url"]);
    const chat = opts.serializers.req({
      method: "POST",
      url: "/babies/11111111-1111-4111-8111-111111111111/chat/messages",
      routeOptions: { url: "/babies/:id/chat/messages" },
      body: { text: "SECRET-QUESTION" },
    } as never);
    expect(JSON.stringify(chat)).not.toContain("SECRET-QUESTION");
  });
});
