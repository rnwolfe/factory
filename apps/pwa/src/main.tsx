import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app.tsx";
import { registerServiceWorker } from "./lib/notifications.ts";
import "./styles/app.css";

// Register the SW eagerly so existing-permission devices keep receiving
// pushes when the operator merely opens the PWA. New devices still need to
// opt in via Settings → Notifications. Errors are logged inside the helper.
void registerServiceWorker();

// SW posts deep-link URLs back to all open clients on notification click.
// The router lives below — we just push the URL through history.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    const data = e.data as { type?: string; url?: string } | null;
    if (data?.type === "factory-notification-click" && typeof data.url === "string") {
      window.history.pushState({}, "", data.url);
      // BrowserRouter listens to popstate, not pushState — nudge it.
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: true,
      staleTime: 4_000,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
