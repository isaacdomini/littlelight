import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { signOutRequest } from "../lib/authApi";
import { useAuth } from "./AuthProvider";

/** Signs out this device (`local`) or every device (`global`), then returns to /welcome. */
export function useSignOut() {
  const { clearSession } = useAuth();
  const navigate = useNavigate();
  return useCallback(
    async (scope: "local" | "global") => {
      try {
        await signOutRequest(scope);
      } catch {
        // Already signed out (401) or offline: clear local state either way.
      }
      clearSession();
      navigate("/welcome", { replace: true });
    },
    [clearSession, navigate],
  );
}
