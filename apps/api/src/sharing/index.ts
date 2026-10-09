import type { FastifyInstance } from "fastify";
import { adminShareRoutes } from "./admin-routes";
import { viewerRoutes } from "./viewer-routes";
import { viewerSessionRoutes } from "./viewer-session";

// Public surface of `apps/api/src/sharing` (docs/plans/step-8.md 2.2, 2.5, 2.6; PRD "FR-9
// Sharing", "Share-link viewers (no account)").
// - `registerViewerAuth(app, config)`: the `onRequest` hook for `/share/*` (`request.viewer`
//   from the `ll_viewer` cookie or a native bearer viewer JWT). Call next to `registerAuth`,
//   before any route module. Parent credentials are never accepted there, and viewer JWTs are
//   never accepted by the parent hook (different key, issuer and audience).
// - `registerSharing(app)`: admin share-link routes (role `authenticated`, admins only), the token
//   exchange (`POST /share/session`, the module's only service_role transaction besides viewer
//   sign-out) and the viewer routes (role `viewer`, after `viewer_session_check`).

export {
  hashClientIp,
  hashPasscode,
  hashShareToken,
  mintViewerJwt,
  newShareToken,
  shareLinkUrl,
  VIEWER_JWT_CLOCK_TOLERANCE_SEC,
  ViewerJwtError,
  verifyPasscode,
  verifyViewerJwt,
  viewerJwtIssuer,
} from "./crypto";
export {
  registerViewerAuth,
  requireViewer,
  type ViewerAuth,
  type ViewerSession,
  viewerCookieOptions,
  withViewer,
} from "./viewer-auth";
export { downloadDisposition, viewerManifest } from "./viewer-routes";

/**
 * Register the admin share-link routes, the token exchange and the viewer routes. Call after
 * `registerAuth` and `registerViewerAuth`.
 */
export async function registerSharing(app: FastifyInstance): Promise<void> {
  adminShareRoutes(app);
  viewerSessionRoutes(app);
  viewerRoutes(app);
}
