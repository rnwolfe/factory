import { useQuery } from "@tanstack/react-query";
import { trpc } from "./trpc.ts";

/**
 * The single "needs you" count — pending, non-snoozed decisions only. Amber is
 * rationed to "a decision is yours", and this is the ONE attention signal:
 * every badge surface (desktop sidebar, mobile nav, installed-app icon via
 * `useAppBadge`) reads it, so they can never drift to different numbers.
 *
 * Polling is the fallback; the inbox route's `/ws/inbox` handler invalidates
 * `["decisions.needsYouCount"]` for instant push updates, so a slow interval
 * is enough here.
 */
export function useNeedsYouCount(enabled: boolean): number {
  const q = useQuery({
    queryKey: ["decisions.needsYouCount"],
    queryFn: () => trpc.decisions.needsYouCount.query() as unknown as Promise<number>,
    refetchInterval: 20_000,
    enabled,
  });
  return q.data ?? 0;
}
