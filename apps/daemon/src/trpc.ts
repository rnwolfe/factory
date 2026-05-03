import { initTRPC, TRPCError } from "@trpc/server";
import type { DaemonContext } from "./context.ts";

const t = initTRPC.context<DaemonContext>().create();

export const router = t.router;
export const middleware = t.middleware;

export const publicProcedure = t.procedure;

const authedMiddleware = middleware(({ ctx, next }) => {
  if (!ctx.authorized) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Bearer token required" });
  }
  return next({ ctx });
});

export const protectedProcedure = t.procedure.use(authedMiddleware);
