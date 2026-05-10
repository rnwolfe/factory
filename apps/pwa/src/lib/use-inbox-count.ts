import { useQuery } from "@tanstack/react-query";
import { trpc } from "./trpc.ts";

// Sums the four inbox feeds (decisions + plans + audits + feedback). Both
// useAppBadge and the desktop sidebar consume this; react-query dedupes the
// underlying queries since the keys match what the Inbox route already polls.
export function useInboxCount(enabled: boolean): number {
  const decisions = useQuery({
    queryKey: ["decisions.inbox"],
    queryFn: () => trpc.decisions.inbox.query() as unknown as Promise<unknown[]>,
    refetchInterval: 6_000,
    enabled,
  });
  const plans = useQuery({
    queryKey: ["plans.inbox"],
    queryFn: () => trpc.plans.inbox.query() as unknown as Promise<unknown[]>,
    refetchInterval: 6_000,
    enabled,
  });
  const audits = useQuery({
    queryKey: ["audits.inbox"],
    queryFn: () => trpc.audits.inbox.query() as unknown as Promise<unknown[]>,
    refetchInterval: 6_000,
    enabled,
  });
  const feedback = useQuery({
    queryKey: ["feedback.inbox"],
    queryFn: () => trpc.feedback.inbox.query() as unknown as Promise<unknown[]>,
    refetchInterval: 6_000,
    enabled,
  });

  return (
    (decisions.data?.length ?? 0) +
    (plans.data?.length ?? 0) +
    (audits.data?.length ?? 0) +
    (feedback.data?.length ?? 0)
  );
}
