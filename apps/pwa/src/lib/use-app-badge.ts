import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { trpc } from "./trpc.ts";

// Reuses the four inbox query keys so react-query dedupes the polling
// when the Inbox route is also mounted. When the operator is elsewhere,
// this hook keeps the queries warm on its own.
export function useAppBadge(enabled: boolean) {
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

  const total =
    (decisions.data?.length ?? 0) +
    (plans.data?.length ?? 0) +
    (audits.data?.length ?? 0) +
    (feedback.data?.length ?? 0);

  useEffect(() => {
    if (typeof navigator.setAppBadge !== "function") return;
    if (!enabled || total === 0) {
      void navigator.clearAppBadge();
      return;
    }
    void navigator.setAppBadge(total);
  }, [total, enabled]);
}
