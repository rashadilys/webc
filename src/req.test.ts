import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { request, ErrorType, type RequestFailure } from "./req.ts";

function fakeFetch(response: Response | (() => Response), delayMs = 0) {
  const calls: { url: RequestInfo | URL; init?: RequestInit }[] = [];

  const impl = (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url, init });

    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;

      const settle = () =>
        resolve(typeof response === "function" ? response() : response);

      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }

      const timer = setTimeout(settle, delayMs);

      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      });
    });
  };

  return { impl: impl as unknown as typeof fetch, calls };
}

function brokenFetch(err: unknown) {
  return (() => Promise.reject(err)) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers as any) },
  });
}

function expectFailure<T>(res: {
  ok: boolean;
}): asserts res is RequestFailure<T> {
  assert.equal(res.ok, false);
}

describe("success cases", () => {
  test("basic GET, parses JSON", async () => {
    const { impl } = fakeFetch(jsonResponse({ id: "1", name: "Ada" }));
    const res = await request<{ id: string; name: string }, any>(
      impl,
      "https://api.example.com/users/1",
      "GET"
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.data, { id: "1", name: "Ada" });
      assert.equal(res.status, 200);
      assert.ok(res.headers instanceof Headers);
    }
  });

  test("query params appended", async () => {
    const { impl, calls } = fakeFetch(jsonResponse([]));
    await request(impl, "https://api.example.com/users", "GET", {
      queries: { q: "ada", limit: 20, active: true },
    });
    const calledUrl = new URL(calls[0].url as string);
    assert.equal(calledUrl.searchParams.get("q"), "ada");
    assert.equal(calledUrl.searchParams.get("limit"), "20");
    assert.equal(calledUrl.searchParams.get("active"), "true");
  });

  test("default Accept: application/json", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({}));
    await request(impl, "https://api.example.com/x", "GET");
    const headers = calls[0].init?.headers as Headers;
    assert.equal(headers.get("Accept"), "application/json");
  });

  test("Accept: text/plain when accept: text", async () => {
    const { impl, calls } = fakeFetch(new Response("hello"));
    await request(impl, "https://api.example.com/x", "GET", { accept: "text" });
    const headers = calls[0].init?.headers as Headers;
    assert.equal(headers.get("Accept"), "text/plain");
  });

  test("Bearer authorization header", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({}));
    await request(impl, "https://api.example.com/x", "GET", {
      bearerAuthorization: "abc123",
    });
    const headers = calls[0].init?.headers as Headers;
    assert.equal(headers.get("Authorization"), "Bearer abc123");
  });

  test("does not overwrite caller header by default", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({}));
    const callerHeaders = new Headers({ Accept: "application/vnd.api+json" });
    await request(impl, "https://api.example.com/x", "GET", {
      headers: callerHeaders,
    });
    const headers = calls[0].init?.headers as Headers;
    assert.equal(headers.get("Accept"), "application/vnd.api+json");
  });

  test("overrideHeaders true overwrites caller header", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({}));
    const callerHeaders = new Headers({ Accept: "application/vnd.api+json" });
    await request(impl, "https://api.example.com/x", "GET", {
      headers: callerHeaders,
      overrideHeaders: true,
    });
    const headers = calls[0].init?.headers as Headers;
    assert.equal(headers.get("Accept"), "application/json");
  });

  test("JSON-serializes object body, sets Content-Type", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ ok: true }));
    await request(impl, "https://api.example.com/users", "POST", {
      body: { name: "Ada" },
    });
    const headers = calls[0].init?.headers as Headers;
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(calls[0].init?.body, JSON.stringify({ name: "Ada" }));
  });

  test("string body passed through unchanged for json contentType", async () => {
    const { impl, calls } = fakeFetch(jsonResponse({ ok: true }));
    const pre = JSON.stringify({ name: "Ada" });
    await request(impl, "https://api.example.com/users", "POST", { body: pre });
    assert.equal(calls[0].init?.body, pre);
  });

  test("string body accepted for text contentType", async () => {
    const { impl, calls } = fakeFetch(new Response("ok"));
    await request(impl, "https://api.example.com/logs", "POST", {
      contentType: "text",
      accept: "text",
      body: "plain text payload",
    });
    assert.equal(calls[0].init?.body, "plain text payload");
    const headers = calls[0].init?.headers as Headers;
    assert.equal(headers.get("Content-Type"), "text/plain");
  });

  test("DELETE with no body sends no body", async () => {
    const { impl, calls } = fakeFetch(new Response(null, { status: 204 }));
    const res = await request(
      impl,
      "https://api.example.com/users/1",
      "DELETE"
    );
    assert.equal(res.ok, true);
    assert.equal(calls[0].init?.body, undefined);
  });

  test("empty body (json) -> null data, not a parse failure", async () => {
    const headers = new Headers();

    headers.set("Content-Type", "application/json");

    const { impl } = fakeFetch(new Response("", { status: 200, headers }));
    const res = await request(impl, "https://api.example.com/x", "GET");
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.data, null);
  });

  test("empty body (text) -> null data, not a parse failure", async () => {
    const { impl } = fakeFetch(new Response("", { status: 200 }));
    const res = await request(impl, "https://api.example.com/x", "GET");
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.data, null);
  });

  test("error body -> even if response is not okay, the response data returned", async () => {
    const { impl } = fakeFetch(
      new Response(JSON.stringify({ message: "Bad Request" }), { status: 400 })
    );
    const res = await request(impl, "https://api.example.com/x", "GET");
    assert.equal(res.ok, false);
    if (!res.ok) assert.deepEqual(res.errorBody, { message: "Bad Request" });
  });

  test("HEAD never attempts body parsing", async () => {
    const { impl } = fakeFetch(
      new Response("this would fail to parse as json")
    );
    const res = await request(impl, "https://api.example.com/x", "HEAD");
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.data, null);
  });
});

describe("failure cases", () => {
  test("non-2xx -> ResponseStatus", async () => {
    const { impl } = fakeFetch(
      new Response(JSON.stringify({ message: "nope" }), { status: 404 })
    );
    const res = await request(impl, "https://api.example.com/users/999", "GET");
    expectFailure(res);
    assert.equal(res.status, 404);
    assert.equal(res.errorType, ErrorType.ResponseStatus);
  });

  test("malformed JSON -> ResponseParse", async () => {
    const { impl } = fakeFetch(
      new Response("{not valid json", { status: 200 })
    );
    const res = await request(impl, "https://api.example.com/x", "GET");
    expectFailure(res);
    assert.equal(res.errorType, ErrorType.ResponseParse);
  });

  test("text contentType + non-string body -> RequestBodyEncoding, no fetch call", async () => {
    const { impl, calls } = fakeFetch(new Response("ok"));
    const res = await request(impl, "https://api.example.com/x", "POST", {
      contentType: "text",
      body: { not: "a string" },
    });
    expectFailure(res);
    assert.equal(res.errorType, ErrorType.RequestBodyEncoding);
    assert.equal(calls.length, 0);
  });

  test("TypeError 'Failed to fetch' -> Network", async () => {
    const impl = brokenFetch(new TypeError("Failed to fetch"));
    const res = await request(impl, "https://api.example.com/x", "GET");
    expectFailure(res);
    assert.equal(res.errorType, ErrorType.Network);
  });

  test("TypeError 'fetch failed' -> Network", async () => {
    const impl = brokenFetch(new TypeError("fetch failed"));
    const res = await request(impl, "https://api.example.com/x", "GET");
    expectFailure(res);
    assert.equal(res.errorType, ErrorType.Network);
  });

  test("ECONNREFUSED -> Network", async () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const impl = brokenFetch(err);
    const res = await request(impl, "https://api.example.com/x", "GET");
    expectFailure(res);
    assert.equal(res.errorType, ErrorType.Network);
  });

  test("unrecognized error -> Unknown", async () => {
    const impl = brokenFetch(new Error("something weird happened"));
    const res = await request(impl, "https://api.example.com/x", "GET");
    expectFailure(res);
    assert.equal(res.errorType, ErrorType.Unknown);
  });
});

describe("timeout and cancellation", () => {
  test("timeout fires before slow response -> Aborted", async () => {
    const { impl } = fakeFetch(jsonResponse({}), 200);
    const res = await request(impl, "https://api.example.com/slow", "GET", {
      timeout: 10,
    });
    expectFailure(res);
    assert.equal(res.errorType, ErrorType.Aborted);
  });

  test("response before timeout -> success", async () => {
    const { impl } = fakeFetch(jsonResponse({ fast: true }), 5);
    const res = await request(impl, "https://api.example.com/fast", "GET", {
      timeout: 500,
    });
    assert.equal(res.ok, true);
  });

  test("manual abort -> Aborted", async () => {
    const { impl } = fakeFetch(jsonResponse({}), 200);
    const controller = new AbortController();
    const promise = request(impl, "https://api.example.com/slow", "GET", {
      signal: controller.signal,
    });
    controller.abort();
    const res = await promise;
    expectFailure(res);
    assert.equal(res.errorType, ErrorType.Aborted);
  });

  test("manual abort wins over a longer timeout (AbortSignal.any)", async () => {
    const { impl } = fakeFetch(jsonResponse({}), 500);
    const controller = new AbortController();
    const promise = request(impl, "https://api.example.com/slow", "GET", {
      timeout: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    const res = await promise;
    expectFailure(res);
    assert.equal(res.errorType, ErrorType.Aborted);
  });
});
