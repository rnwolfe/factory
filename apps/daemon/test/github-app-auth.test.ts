import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  appJwt,
  GithubAppClient,
  parseGithubRepo,
  resolveBotGitAuthor,
} from "../src/github/app-auth.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const creds = { appId: "123456", slug: "factory", privateKey };
const appConfig = { githubApp: { ...creds, webhookSecret: null } };

type FakeFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const asFetch = (f: FakeFetch) => f as unknown as typeof fetch;

function decodeJwt(jwt: string): {
  header: unknown;
  payload: { iss: string; iat: number; exp: number };
} {
  const parts = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString()),
    payload: JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString()),
  };
}

describe("appJwt", () => {
  test("emits RS256 claims with iss=appId and a ≤10m window", () => {
    const now = 1_000_000;
    const { header, payload } = decodeJwt(appJwt(creds, now));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 540);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });

  test("signature verifies against the public key", () => {
    const parts = appJwt(creds, 1_000_000).split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    expect(verifier.verify(publicKey, Buffer.from(parts[2] ?? "", "base64url"))).toBe(true);
  });
});

describe("GithubAppClient", () => {
  test("caches installation tokens until ~1m before expiry", async () => {
    let calls = 0;
    const client = new GithubAppClient(
      creds,
      asFetch(async () => {
        calls++;
        return new Response(
          JSON.stringify({ token: "ghs_abc", expires_at: new Date(10_000_000).toISOString() }),
          { status: 200 },
        );
      }),
    );
    const t1 = await client.installationToken(42, 9_000_000);
    const t2 = await client.installationToken(42, 9_500_000);
    expect(t1).toBe("ghs_abc");
    expect(t2).toBe("ghs_abc");
    expect(calls).toBe(1);
  });

  test("refetches when the cached token is within 1m of expiry", async () => {
    let calls = 0;
    const client = new GithubAppClient(
      creds,
      asFetch(async () => {
        calls++;
        return new Response(
          JSON.stringify({ token: `ghs_${calls}`, expires_at: new Date(10_000_000).toISOString() }),
          { status: 200 },
        );
      }),
    );
    await client.installationToken(7, 9_000_000);
    await client.installationToken(7, 9_950_000);
    expect(calls).toBe(2);
  });

  test("botIdentity builds the noreply email from the bot user id", async () => {
    const client = new GithubAppClient(
      creds,
      asFetch(async (url) => {
        expect(String(url)).toContain("/users/factory%5Bbot%5D");
        return new Response(JSON.stringify({ id: 9999 }), { status: 200 });
      }),
    );
    expect(await client.botIdentity()).toEqual({
      name: "factory[bot]",
      email: "9999+factory[bot]@users.noreply.github.com",
      userId: 9999,
    });
  });

  test("installationId throws not_installed on 404", async () => {
    const client = new GithubAppClient(
      creds,
      asFetch(async () => new Response("not found", { status: 404 })),
    );
    await expect(client.installationId("o", "r")).rejects.toThrow(/not installed/i);
  });
});

describe("parseGithubRepo", () => {
  test("parses https and ssh remotes", () => {
    expect(parseGithubRepo("https://github.com/acme/widget.git")).toEqual({
      owner: "acme",
      repo: "widget",
    });
    expect(parseGithubRepo("git@github.com:acme/widget.git")).toEqual({
      owner: "acme",
      repo: "widget",
    });
    expect(parseGithubRepo("https://github.com/acme/widget")).toEqual({
      owner: "acme",
      repo: "widget",
    });
  });

  test("returns null for non-github remotes", () => {
    expect(parseGithubRepo("https://gitlab.com/a/b.git")).toBeNull();
  });
});

describe("resolveBotGitAuthor", () => {
  test("returns null with no network when the App is unconfigured", async () => {
    let called = false;
    const result = await resolveBotGitAuthor(
      { githubApp: null },
      "https://github.com/a/b.git",
      asFetch(async () => {
        called = true;
        return new Response("{}");
      }),
    );
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test("falls back to null when the App is not installed", async () => {
    const result = await resolveBotGitAuthor(
      appConfig,
      "https://github.com/a/b.git",
      asFetch(async (url) =>
        String(url).includes("/installation")
          ? new Response("nope", { status: 404 })
          : new Response(JSON.stringify({ id: 1 }), { status: 200 }),
      ),
    );
    expect(result).toBeNull();
  });

  test("resolves the bot identity when configured and installed", async () => {
    const result = await resolveBotGitAuthor(
      appConfig,
      "https://github.com/a/b.git",
      asFetch(async (url) => {
        const u = String(url);
        if (u.includes("/installation"))
          return new Response(JSON.stringify({ id: 55 }), { status: 200 });
        if (u.includes("/users/"))
          return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
        return new Response("{}", { status: 200 });
      }),
    );
    expect(result).toEqual({
      name: "factory[bot]",
      email: "4242+factory[bot]@users.noreply.github.com",
      userId: 4242,
    });
  });
});
