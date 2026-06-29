import { useQuery } from "@tanstack/react-query";
import { trpc } from "./trpc.ts";

/**
 * The narrow "needs you" count — pending, non-snoozed decisions only. Backs the
 * amber inbox nav badge (amber is rationed to "a decision is yours"). Distinct
 * from `useInboxCount`, which sums every feed for the total.
 */
export function useNeedsYouCount(enabled: boolean): number {
  const q = useQuery({
    queryKey: ["decisions.needsYouCount"],
    queryFn: () => trpc.decisions.needsYouCount.query() as unknown as Promise<number>,
    refetchInterval: 6_000,
    enabled,
  });
  return q.data ?? 0;
}
