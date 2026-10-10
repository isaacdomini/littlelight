import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type SearchQuery,
  searchFacetsResponseSchema,
  searchResponseSchema,
} from "@tinyglow/shared";
import { apiFetch } from "../api";

/** Filters as the UI holds them; empty values are never sent (an empty `q` is a 400). */
export interface SearchParams {
  q: string;
  dateFrom: string;
  dateTo: string;
  milestoneId: string;
  person: string;
  place: string;
  tag: string;
  ageFrom: string;
  ageTo: string;
}

export const EMPTY_SEARCH: SearchParams = {
  q: "",
  dateFrom: "",
  dateTo: "",
  milestoneId: "",
  person: "",
  place: "",
  tag: "",
  ageFrom: "",
  ageTo: "",
};

/** True when a query or any filter is set. */
export function hasSearch(p: SearchParams): boolean {
  return Object.values(p).some((v) => v.trim() !== "");
}

/** Query string of the non-empty params (the API's zod schema coerces and validates). */
export function searchQueryString(p: SearchParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p) as [keyof SearchQuery, string][]) {
    if (v.trim() !== "") qs.set(k, v.trim());
  }
  return qs.toString();
}

export const searchKey = (babyId: string, qs: string) => ["babies", babyId, "search", qs] as const;
export const facetsKey = (babyId: string) => ["babies", babyId, "search-facets"] as const;

/** `GET /babies/:id/search` (paid admins); enabled once a query or filter is set. */
export function useSearch(babyId: string | undefined, params: SearchParams, enabled: boolean) {
  const qs = searchQueryString(params);
  return useQuery({
    queryKey: searchKey(babyId ?? "none", qs),
    enabled: !!babyId && enabled && qs !== "",
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: () => apiFetch(`/babies/${babyId}/search?${qs}`, { schema: searchResponseSchema }),
  });
}

/** `GET /babies/:id/search/facets`: chip values with counts (cached 60 s). */
export function useSearchFacets(babyId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: facetsKey(babyId ?? "none"),
    enabled: !!babyId && enabled,
    staleTime: 60_000,
    queryFn: () =>
      apiFetch(`/babies/${babyId}/search/facets`, { schema: searchFacetsResponseSchema }),
  });
}
