import { describe, expect, it } from "vitest";
import { mapPgError } from "./errors";

const pg = (code: string, message: string) =>
  Object.assign(new Error(message), { code, severity: "ERROR" });

// Step 9 (docs/plans/step-9.md 2.8): the fixed messages of migration 16's functions map to
// specific API errors; nothing from the database (and no token) reaches the client.
describe("mapPgError: step 9 push messages", () => {
  it("23514 invalid platform/provider is a 400 on body.provider", () => {
    const e = mapPgError(pg("23514", "push registration has an invalid platform or provider"));
    expect(e).toMatchObject({ status: 400, code: "validation_failed" });
    expect(e.toBody()).toMatchObject({ details: { fields: ["body.provider"] } });
  });

  it("23514 token and app version shapes are 400s naming their fields", () => {
    const token = mapPgError(pg("23514", "push_devices.token has an invalid shape"));
    expect(token).toMatchObject({ status: 400, code: "validation_failed" });
    expect(JSON.stringify(token.toBody())).toContain("body.token");
    const version = mapPgError(pg("23514", "push_devices.app_version has an invalid shape"));
    expect(version).toMatchObject({ status: 400, code: "validation_failed" });
    expect(JSON.stringify(version.toBody())).toContain("body.appVersion");
  });

  it("42501 'push registration needs a session' is a 401 session_revoked", () => {
    expect(mapPgError(pg("42501", "push registration needs a session"))).toMatchObject({
      status: 401,
      code: "session_revoked",
    });
  });

  it("42501 'push registration needs a profile' is a 403 consent_required", () => {
    expect(mapPgError(pg("42501", "push registration needs a profile"))).toMatchObject({
      status: 403,
      code: "consent_required",
    });
  });

  it("any other 42501 stays a plain 403 forbidden", () => {
    expect(mapPgError(pg("42501", "permission denied for table push_devices"))).toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(mapPgError(pg("42501", "something else needs a session"))).toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it("never echoes the database message or a token", () => {
    const token = "tok-secret-0123456789";
    for (const [code, message] of [
      ["23514", "push_devices.token has an invalid shape"],
      ["42501", "push registration needs a session"],
      ["23514", `new row for relation "push_devices" violates check constraint (token)=(${token})`],
    ] as const) {
      const body = JSON.stringify(mapPgError(pg(code, `${message} ${token}`)).toBody());
      expect(body).not.toContain(token);
      expect(body).not.toContain("push_devices");
    }
  });
});
