import { useEffect } from "react";
import { useNeedsYouCount } from "./use-needs-you-count.ts";

export function useAppBadge(enabled: boolean) {
  const total = useNeedsYouCount(enabled);

  useEffect(() => {
    if (typeof navigator.setAppBadge !== "function") return;
    if (!enabled || total === 0) {
      void navigator.clearAppBadge();
      return;
    }
    void navigator.setAppBadge(total);
  }, [total, enabled]);
}
