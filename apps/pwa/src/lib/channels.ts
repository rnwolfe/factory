import { useMemo } from "react";
import { type ChannelScope, useScopedChannel } from "./use-channel.ts";

type QueryKey = readonly unknown[];

/**
 * Typed wrappers around `useScopedChannel`. Each takes the IDs that scope
 * the channel and an array of React Query key prefixes to invalidate on
 * every matching event. Coarse-grained — invalidates everything in the
 * key list on any event. Fine-grained per-event-kind routing is a future
 * optimization if the chatter becomes a problem.
 */

export function useProjectChannel(projectId: string | null | undefined, keys: QueryKey[]): void {
  const scope = useMemo<ChannelScope | null>(
    () => (projectId ? { kind: "project", id: projectId } : null),
    [projectId],
  );
  useScopedChannel(scope, { invalidate: keys });
}

export function useRunChannel(runId: string | null | undefined, keys: QueryKey[]): void {
  const scope = useMemo<ChannelScope | null>(
    () => (runId ? { kind: "run", id: runId } : null),
    [runId],
  );
  useScopedChannel(scope, { invalidate: keys });
}

export function useAuditChannel(auditId: string | null | undefined, keys: QueryKey[]): void {
  const scope = useMemo<ChannelScope | null>(
    () => (auditId ? { kind: "audit", id: auditId } : null),
    [auditId],
  );
  useScopedChannel(scope, { invalidate: keys });
}

export function usePlanChannel(planId: string | null | undefined, keys: QueryKey[]): void {
  const scope = useMemo<ChannelScope | null>(
    () => (planId ? { kind: "plan", id: planId } : null),
    [planId],
  );
  useScopedChannel(scope, { invalidate: keys });
}

export function useDecisionChannel(decisionId: string | null | undefined, keys: QueryKey[]): void {
  const scope = useMemo<ChannelScope | null>(
    () => (decisionId ? { kind: "decision", id: decisionId } : null),
    [decisionId],
  );
  useScopedChannel(scope, { invalidate: keys });
}
