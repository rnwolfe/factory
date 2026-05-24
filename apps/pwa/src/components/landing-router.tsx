import { useQuery } from "@tanstack/react-query";
import { trpc } from "../lib/trpc.ts";
import { Inbox } from "../routes/inbox.tsx";
import { Ops } from "../routes/ops.tsx";

interface SettingsView {
  ops?: { landingRoute?: "inbox" | "ops" };
}

/**
 * Render whichever page the operator picked as their landing — defaults
 * to the inbox (preserves prior behavior). Updates without a reload when
 * the setting changes (settings page invalidates `settings.get` on save).
 *
 * Mounted at `/`; the explicit `/inbox` and `/ops` routes always show
 * their respective pages regardless of this setting.
 */
export function LandingRouter() {
  const settings = useQuery({
    queryKey: ["settings.get"],
    queryFn: () => trpc.settings.get.query() as unknown as Promise<SettingsView>,
    // Cheap to refetch; settings rarely change.
    staleTime: 60_000,
  });
  const landingRoute = settings.data?.ops?.landingRoute ?? "inbox";
  return landingRoute === "ops" ? <Ops /> : <Inbox />;
}
