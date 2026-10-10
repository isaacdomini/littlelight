/**
 * Prints one invite token (43-char base64url) for a fresh address, created by the seeded demo mom
 * through the real API and read back from the invite mail in Mailpit. Used by the native gates to
 * open `tinyglow://invite/<token>` / `https://tinyglow.app/invite/<token>`.
 *
 *   tsx e2e/native/invite-link.ts [--json]   =>  <token>   or   {"email":"...","token":"..."}
 *
 * The token is a live credential for a dev-stack invite: it is printed on stdout only.
 */
import { uniqueEmail } from "../helpers/api";
import { demoClient, MAYA } from "../helpers/demo";

async function main(): Promise<void> {
  const mom = await demoClient("demo-mom");
  const email = uniqueEmail("native-invite");
  const r = await mom.invite(MAYA, email, "contributor");
  await mom.dispose();
  if (!r.token) throw new Error(`invite answered ${r.status}: ${JSON.stringify(r.body)}`);
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify({ email, token: r.token })}\n`
      : `${r.token}\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
