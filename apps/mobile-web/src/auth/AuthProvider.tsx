import type { BabySummary, MeResponse } from "@littlelight/shared";
import { meResponseSchema } from "@littlelight/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { apiFetch, isApiError, onSignedOut } from "../lib/api";
import { clearImageCache } from "../lib/imageCache";
import { currentBabyStore } from "../lib/session";

export const ME_KEY = ["me"] as const;

async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await apiFetch("/me", { schema: meResponseSchema });
  } catch (e) {
    if (isApiError(e) && e.status === 401) return null;
    throw e;
  }
}

interface AuthState {
  /** Undefined while the first `/me` is loading; null when signed out. */
  me: MeResponse | null | undefined;
  isLoading: boolean;
  error: unknown;
  babies: BabySummary[];
  currentBaby: BabySummary | null;
  setCurrentBabyId: (id: string) => void;
  /** Clears all cached data and marks the user signed out (after sign-out / account deletion). */
  clearSession: () => void;
  refetchMe: () => Promise<MeResponse | null>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    staleTime: 30_000,
    retry: (count, e) => (isApiError(e) && e.status > 0 && e.status < 500 ? false : count < 2),
  });
  const [storedBabyId, setStoredBabyId] = useState<string | null>(() => currentBabyStore.get());

  const clearSession = useCallback(() => {
    // Drop everything except the bootstrap query itself, which becomes "signed out".
    queryClient.removeQueries({
      predicate: (q) => q.queryKey[0] !== "me" || q.queryKey.length > 1,
    });
    queryClient.setQueryData(ME_KEY, null);
    void clearImageCache();
  }, [queryClient]);

  useEffect(() => onSignedOut(clearSession), [clearSession]);

  const me = query.data;
  const babies = me?.babies ?? [];
  const currentBaby = useMemo(
    () => babies.find((b) => b.id === storedBabyId) ?? babies[0] ?? null,
    [babies, storedBabyId],
  );

  const setCurrentBabyId = useCallback((id: string) => {
    currentBabyStore.set(id);
    setStoredBabyId(id);
  }, []);

  const refetchMe = useCallback(async () => {
    const res = await query.refetch();
    return res.data ?? null;
  }, [query]);

  const value: AuthState = {
    me,
    isLoading: query.isPending,
    error: query.error,
    babies,
    currentBaby,
    setCurrentBabyId,
    clearSession,
    refetchMe,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** The selected baby (validated against `me.babies`, falling back to the first). */
export function useCurrentBaby() {
  const { currentBaby, babies, setCurrentBabyId } = useAuth();
  return { baby: currentBaby, babies, setCurrentBabyId };
}
