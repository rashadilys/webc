/**
 * Test suite for http.ts (the get/post/put/patch/del/head/httpOptions
 * helpers built on top of request()).
 *
 * These tests deliberately do NOT re-test everything request.ts already
 * covers (header building, timeout/abort behavior, JSON parsing edge
 * cases, etc — see request-rewrite.test.ts for that). The job of this
 * suite is narrower: prove that each helper
 *   1. calls the underlying fetch with the right HTTP method
 *   2. puts the body in the right place, encoded correctly
 *   3. forwards options (queries, headers, etc.) through untouched
 *   4. passes request()'s result straight through, success or failure
 *   5. falls back to the global `fetch` when no fetchImpl is given
 *
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { get, post, put, patch, del, head, httpOptions, http } from "./http";
import { ErrorType } from "./request";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fakeFetch(response: Response | (() => Response)) {
  const calls: { url: string; init?: RequestInit }[] = [];

  const impl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    return Promise.resolve(
      typeof response === "function" ? response() : response
    );
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers as any) },
  });
}

// ---------------------------------------------------------------------------
// get / head / httpOptions — no-body verbs
// ---------------------------------------------------------------------------

describe("get()", () => {
  it("dispatches a GET request with no body", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ id: "1" }));

    const res = await get<{ id: string }>(
      "https://api.example.com/users/1",
      undefined,
      impl
    );

    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.body).toBeUndefined();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ id: "1" });
  });

  it("forwards options (queries, headers) to request()", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({}));

    await get(
      "https://api.example.com/users",
      { queries: { q: "ada" }, bearerAuthorization: "tok123" },
      impl
    );

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("q")).toBe("ada");

    const headers = calls[0].init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok123");
  });

  it("propagates a failure result unchanged (non-2xx)", async () => {
    const { impl } = fakeFetch(
      new Response(JSON.stringify({ message: "not found" }), { status: 404 })
    );

    const res = await get("https://api.example.com/users/999", undefined, impl);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.errorType).toBe(ErrorType.ResponseStatus);
    }
  });
});

describe("head()", () => {
  it("dispatches a HEAD request", async () => {
    const { impl, calls } = fakeFetch(new Response(null, { status: 200 }));

    const res = await head("https://api.example.com/users/1", undefined, impl);

    expect(calls[0].init?.method).toBe("HEAD");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBeNull();
  });
});

describe("httpOptions()", () => {
  it("dispatches an OPTIONS request", async () => {
    const { impl, calls } = fakeFetch(new Response(null, { status: 204 }));

    await httpOptions("https://api.example.com/users", undefined, impl);

    expect(calls[0].init?.method).toBe("OPTIONS");
  });
});

// ---------------------------------------------------------------------------
// post / put / patch — body-taking verbs
// ---------------------------------------------------------------------------

describe.each([
  ["post", post, "POST"],
  ["put", put, "PUT"],
  ["patch", patch, "PATCH"],
] as const)("%s()", (_name, fn, expectedMethod) => {
  it(`dispatches a ${expectedMethod} request`, async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ ok: true }));

    await fn("https://api.example.com/users", { name: "Ada" }, undefined, impl);

    expect(calls[0].init?.method).toBe(expectedMethod);
  });

  it("JSON-encodes an object body and sets Content-Type", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ ok: true }));

    await fn("https://api.example.com/users", { name: "Ada" }, undefined, impl);

    expect(calls[0].init?.body).toBe(JSON.stringify({ name: "Ada" }));
    const headers = calls[0].init?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("works with no body at all", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ ok: true }));

    const res = await fn(
      "https://api.example.com/users/1/ping",
      undefined,
      undefined,
      impl
    );

    expect(calls[0].init?.body).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("forwards options alongside the body", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ ok: true }));

    await fn(
      "https://api.example.com/users",
      { name: "Ada" },
      { bearerAuthorization: "tok123" },
      impl
    );

    const headers = calls[0].init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok123");
  });

  it("propagates a failure result, including a parsed error body", async () => {
    const { impl } = fakeFetch(
      new Response(JSON.stringify({ message: "invalid", code: 422 }), {
        status: 422,
      })
    );

    const res = await fn(
      "https://api.example.com/users",
      { name: "" },
      undefined,
      impl
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(422);
      expect(res.errorBody).toEqual({ message: "invalid", code: 422 });
    }
  });
});

// ---------------------------------------------------------------------------
// del — body-taking, but body is optional
// ---------------------------------------------------------------------------

describe("del()", () => {
  it("dispatches a DELETE request with no body", async () => {
    const { impl, calls } = fakeFetch(new Response(null, { status: 204 }));

    const res = await del(
      "https://api.example.com/users/1",
      undefined,
      undefined,
      impl
    );

    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[0].init?.body).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("can send an optional body (e.g. bulk delete by id list)", async () => {
    const { impl, calls } = fakeFetch(new Response(null, { status: 204 }));

    await del(
      "https://api.example.com/users/bulk",
      { ids: [1, 2, 3] },
      undefined,
      impl
    );

    expect(calls[0].init?.body).toBe(JSON.stringify({ ids: [1, 2, 3] }));
  });
});

// ---------------------------------------------------------------------------
// Grouped `http` export
// ---------------------------------------------------------------------------

describe("http.* grouped export", () => {
  it("http.get behaves the same as the named get() export", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ id: "1" }));

    const res = await http.get(
      "https://api.example.com/users/1",
      undefined,
      impl
    );

    expect(calls[0].init?.method).toBe("GET");
    expect(res.ok).toBe(true);
  });

  it("http.del is available under 'del', not the reserved word 'delete'", () => {
    expect(typeof http.del).toBe("function");
    expect((http as any).delete).toBeUndefined();
  });

  it("http.options maps to the httpOptions() implementation", async () => {
    const { impl, calls } = fakeFetch(new Response(null, { status: 204 }));

    await http.options("https://api.example.com/users", undefined, impl);

    expect(calls[0].init?.method).toBe("OPTIONS");
  });
});

// ---------------------------------------------------------------------------
// Default fetchImpl fallback
// ---------------------------------------------------------------------------

describe("default fetchImpl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the global fetch when no fetchImpl is passed", async () => {
    const globalFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true }))
    );
    vi.stubGlobal("fetch", globalFetch);

    const res = await get("https://api.example.com/x");

    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });
});
