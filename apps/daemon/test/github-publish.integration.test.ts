import { describe, expect, test } from "bun:test";
import { createRepo, GithubError } from "../src/projects/github.ts";

function mockFetch(
  responses: Array<{ status?: number; ok?: boolean; body: unknown }>,
): typeof globalThis.fetch {
  let i = 0;
  const fn = async () => {
    const r = responses[i++];
    if (!r) throw new Error("mockFetch ran out of responses");
    const init: ResponseInit = { status: r.status ?? (r.ok === false ? 500 : 200) };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), init);
  };
  return fn as unknown as typeof globalThis.fetch;
}

describe("createRepo", () => {
  test("happy path returns clone url + html url", async () => {
    const fetchFn = mockFetch([
      {
        status: 201,
        body: {
          clone_url: "https://github.com/me/proj.git",
          html_url: "https://github.com/me/proj",
          full_name: "me/proj",
        },
      },
    ]);
    const result = await createRepo(
      {
        token: "ghp_fake",
        owner: { kind: "user" },
        name: "proj",
        visibility: "public",
      },
      fetchFn,
    );
    expect(result.cloneUrlHttps).toBe("https://github.com/me/proj.git");
    expect(result.htmlUrl).toBe("https://github.com/me/proj");
    expect(result.fullName).toBe("me/proj");
  });

  test("401 maps to bad_token GithubError", async () => {
    const fetchFn = mockFetch([{ status: 401, body: { message: "Bad credentials" } }]);
    try {
      await createRepo(
        {
          token: "bad",
          owner: { kind: "user" },
          name: "x",
          visibility: "public",
        },
        fetchFn,
      );
      throw new Error("expected GithubError");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubError);
      expect((err as GithubError).code).toBe("bad_token");
    }
  });

  test("422 maps to name_conflict and includes message", async () => {
    const fetchFn = mockFetch([
      { status: 422, body: { message: "name already exists on this account" } },
    ]);
    try {
      await createRepo(
        {
          token: "ok",
          owner: { kind: "user" },
          name: "exists",
          visibility: "public",
        },
        fetchFn,
      );
      throw new Error("expected GithubError");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubError);
      expect((err as GithubError).code).toBe("name_conflict");
      expect((err as GithubError).message).toContain("already exists");
    }
  });

  test("missing token rejects without making a network call", async () => {
    const fetchFn = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof globalThis.fetch;
    try {
      await createRepo(
        {
          token: "",
          owner: { kind: "user" },
          name: "x",
          visibility: "public",
        },
        fetchFn,
      );
      throw new Error("expected GithubError");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubError);
      expect((err as GithubError).code).toBe("no_token");
    }
  });

  test("org owner uses /orgs/<org>/repos endpoint", async () => {
    let capturedUrl = "";
    const fetchFn = (async (input: string | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({
          clone_url: "https://github.com/myorg/proj.git",
          html_url: "https://github.com/myorg/proj",
          full_name: "myorg/proj",
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;
    await createRepo(
      {
        token: "ok",
        owner: { kind: "org", org: "myorg" },
        name: "proj",
        visibility: "private",
      },
      fetchFn,
    );
    expect(capturedUrl).toBe("https://api.github.com/orgs/myorg/repos");
  });
});
