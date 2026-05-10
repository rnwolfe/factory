import { useEffect } from "react";
import { useInboxCount } from "./use-inbox-count.ts";

export function useAppBadge(enabled: boolean) {
  const total = useInboxCount(enabled);

  useEffect(() => {
    if (typeof navigator.setAppBadge !== "function") return;
    if (!enabled || total === 0) {
      void navigator.clearAppBadge();
      return;
    }
    void navigator.setAppBadge(total);
  }, [total, enabled]);
}
