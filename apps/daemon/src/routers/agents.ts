import { type AgentDescriptor, ALL_AGENT_DESCRIPTORS, FABLE_5_MODEL } from "../agents/registry.ts";
import { readAllSettings, readOpsSettings } from "../settings/store.ts";
import { protectedProcedure, router } from "../trpc.ts";

/**
 * Serializable view of an {@link AgentDescriptor}. Functions (`probeAuth`,
 * `buildInteractiveCommand`) and the runtime spec stay daemon-side; the PWA
 * gets only what it needs to render the picker / surface agent metadata.
 */
export interface AgentDescriptorView {
  id: string;
  label: string;
  hint: string;
  models: ReadonlyArray<{ id: string | null; label: string; hint: string }>;
  supports: {
    resume: boolean;
    interactiveSession: boolean;
  };
}

function toView(d: AgentDescriptor): AgentDescriptorView {
  return {
    id: d.id,
    label: d.label,
    hint: d.hint,
    models: d.models,
    supports: { ...d.supports },
  };
}

export const agentsRouter = router({
  /**
   * Every registered agent. The PWA picker, settings page, and any future
   * model/agent UI reads from this list so adding a harness is a single
   * registry-entry edit on the daemon — no PWA code changes needed.
   *
   * Experimental models gated behind a user setting are appended here rather
   * than baked into the registry, so opt-out operators never see them. Fable 5
   * rides the `experimental-fable-5` flag.
   */
  list: protectedProcedure.query(({ ctx }) => {
    const ops = readOpsSettings(readAllSettings(ctx.db));
    return ALL_AGENT_DESCRIPTORS.map((d) => {
      const view = toView(d);
      if (d.id === "claude-code" && ops.experimentalFable5) {
        return { ...view, models: [...view.models, FABLE_5_MODEL] };
      }
      return view;
    });
  }),
});
