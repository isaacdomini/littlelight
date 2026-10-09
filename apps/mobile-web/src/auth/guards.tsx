import type { ReactNode } from "react";
import { matchPath, Navigate, useLocation } from "react-router-dom";
import { PageSkeleton } from "../components/ui";
import { pendingInvite } from "../lib/session";
import { useAuth } from "./AuthProvider";
import { nextOnboardingRoute, onboardingGate } from "./onboarding";

/**
 * Ionic keeps previous pages mounted (hidden), and they re-render whenever `['me']` changes.
 * Redirects must therefore only fire while the guard's own route is the active one.
 */
export function useRouteActive(path: string): boolean {
  const { pathname } = useLocation();
  return matchPath({ path, end: true }, pathname) !== null;
}

/** `<Navigate>` that only acts when `path` is the current route (hidden pages stay put). */
export function ActiveNavigate({ path, to }: { path: string; to: string }) {
  const active = useRouteActive(path);
  return active ? <Navigate to={to} replace /> : null;
}

export function FullPageSpinner() {
  return <PageSkeleton />;
}

/** Signed in (consent/profile not required): onboarding screens. */
export function RequireAuth({ path, children }: { path: string; children: ReactNode }) {
  const { me, isLoading } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (!me) return <ActiveNavigate path={path} to="/welcome" />;
  return <>{children}</>;
}

/**
 * Signed in and past consent and profile (and, unless `allowNoBaby`, baby creation): the app.
 * Settings routes set `allowNoBaby` so a user who deleted their last album can still finish
 * deleting the account.
 */
export function RequireOnboarded({
  path,
  allowNoBaby = false,
  children,
}: {
  path: string;
  allowNoBaby?: boolean;
  children: ReactNode;
}) {
  const { me, isLoading } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (!me) return <ActiveNavigate path={path} to="/welcome" />;
  const gate = allowNoBaby
    ? !me.consent.ok
      ? "/onboarding/consent"
      : !me.profileComplete
        ? "/onboarding/profile"
        : null
    : onboardingGate(me, pendingInvite.get());
  if (gate) return <ActiveNavigate path={path} to={gate} />;
  return <>{children}</>;
}

/** Public screens (welcome): bounce signed-in users onward. */
export function RedirectIfSignedIn({ path, children }: { path: string; children: ReactNode }) {
  const { me, isLoading } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (me) return <ActiveNavigate path={path} to={nextOnboardingRoute(me, pendingInvite.get())} />;
  return <>{children}</>;
}

export function RootRedirect() {
  const { me, isLoading } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  return <ActiveNavigate path="/" to={nextOnboardingRoute(me ?? null, pendingInvite.get())} />;
}
