import { schema } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  diffFile,
  diffSummary,
  listBranches,
  listCommits,
  listTree,
  RepoReadError,
  readBlob,
  readImageBlob,
} from "../projects/repo-read.ts";
import { protectedProcedure, router } from "../trpc.ts";

/**
 * Refs accept the standard set of git ref characters. We deliberately
 * reject `..` segments and absolute paths even though `git`'s argv form
 * is shell-injection-safe — defense-in-depth, and keeps logs sane.
 */
const REF_RE = /^[A-Za-z0-9._/\-+]+$/;

function validateRef(ref: string): string {
  if (!ref) throw new TRPCError({ code: "BAD_REQUEST", message: "ref required" });
  if (ref.length > 200) throw new TRPCError({ code: "BAD_REQUEST", message: "ref too long" });
  if (!REF_RE.test(ref)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "ref contains invalid characters" });
  }
  if (ref.startsWith("-")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "ref must not start with '-'" });
  }
  return ref;
}

function validatePath(p: string | undefined): string {
  if (p == null || p === "") return "";
  if (p.length > 4096) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "path too long" });
  }
  if (p.startsWith("/")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "path must be relative" });
  }
  // Reject any segment equal to ".." — also reject leading/trailing slashes.
  const segments = p.split("/");
  for (const s of segments) {
    if (s === "..") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "path contains '..'" });
    }
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 32) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "path contains control characters" });
      }
    }
  }
  // Strip empty leading/trailing segments.
  return segments.filter((s) => s.length > 0).join("/");
}

async function projectWorkdir(ctx: { db: import("@factory/db").Db }, projectId: string) {
  const p = await ctx.db
    .select({ id: schema.projects.id, workdirPath: schema.projects.workdirPath })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });
  return p.workdirPath;
}

function mapError(err: unknown): TRPCError {
  if (err instanceof RepoReadError) {
    if (err.code === "bad_ref" || err.code === "bad_path") {
      return new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    if (err.code === "not_found") {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : String(err),
  });
}

export const repoRouter = router({
  branches: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const wd = await projectWorkdir(ctx, input.projectId);
      try {
        return await listBranches(wd);
      } catch (err) {
        throw mapError(err);
      }
    }),

  commits: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        ref: z.string().default("HEAD"),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const wd = await projectWorkdir(ctx, input.projectId);
      const ref = validateRef(input.ref);
      try {
        return await listCommits(wd, ref, { limit: input.limit, cursor: input.cursor });
      } catch (err) {
        throw mapError(err);
      }
    }),

  tree: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        ref: z.string().default("HEAD"),
        path: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const wd = await projectWorkdir(ctx, input.projectId);
      const ref = validateRef(input.ref);
      const path = validatePath(input.path);
      try {
        return await listTree(wd, ref, path);
      } catch (err) {
        throw mapError(err);
      }
    }),

  blob: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        ref: z.string().default("HEAD"),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const wd = await projectWorkdir(ctx, input.projectId);
      const ref = validateRef(input.ref);
      const path = validatePath(input.path);
      if (!path) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "path required" });
      }
      try {
        return await readBlob(wd, ref, path);
      } catch (err) {
        throw mapError(err);
      }
    }),

  /**
   * Two-ref diff summary. Uses symmetric `base...target` range so the diff
   * is anchored at the merge-base — same shape as a Github comparison.
   */
  diff: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        base: z.string().default("main"),
        target: z.string().default("HEAD"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const wd = await projectWorkdir(ctx, input.projectId);
      const base = validateRef(input.base);
      const target = validateRef(input.target);
      try {
        return await diffSummary(wd, base, target);
      } catch (err) {
        throw mapError(err);
      }
    }),

  /**
   * Unified diff for a single file across the symmetric base...target range.
   * The summary lists files; this is the per-file expansion.
   */
  diffFile: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        base: z.string().default("main"),
        target: z.string().default("HEAD"),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const wd = await projectWorkdir(ctx, input.projectId);
      const base = validateRef(input.base);
      const target = validateRef(input.target);
      const path = validatePath(input.path);
      if (!path) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "path required" });
      }
      try {
        return await diffFile(wd, base, target, path);
      } catch (err) {
        throw mapError(err);
      }
    }),

  /**
   * Image blobs returned as base64 + content-type so the PWA can render them
   * inline via a data URL. Refuses non-image extensions and large files.
   */
  imageBlob: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        ref: z.string().default("HEAD"),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const wd = await projectWorkdir(ctx, input.projectId);
      const ref = validateRef(input.ref);
      const path = validatePath(input.path);
      if (!path) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "path required" });
      }
      try {
        return await readImageBlob(wd, ref, path);
      } catch (err) {
        throw mapError(err);
      }
    }),
});
