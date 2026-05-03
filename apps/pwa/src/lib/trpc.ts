import type { AppRouter } from "@factory/daemon";
import { createTRPCClient, httpBatchLink, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { getToken, useAuth } from "./auth.ts";

const TRPC_URL = "/trpc";

function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(input as RequestInfo, { ...init, headers });
}

const unauthorizedRedirectLink: TRPCLink<AppRouter> =
  () =>
  ({ next, op }) => {
    return observable((observer) => {
      const sub = next(op).subscribe({
        next: (v) => observer.next(v),
        complete: () => observer.complete(),
        error: (err) => {
          if (err?.data?.code === "UNAUTHORIZED") {
            useAuth.getState().clear();
          }
          observer.error(err);
        },
      });
      return () => sub.unsubscribe();
    });
  };

export const trpc = createTRPCClient<AppRouter>({
  links: [
    unauthorizedRedirectLink,
    httpBatchLink({
      url: TRPC_URL,
      fetch: authedFetch,
    }),
  ],
});
