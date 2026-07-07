import { request, type RequestOptions, type RequestResult } from "./request";

/**
 * Same as RequestOptions, minus `body` — the verb helpers below take the
 * body as its own argument instead, so it doesn't belong in the options bag.
 */
type HelperOptions = Omit<RequestOptions, "body">;

// Every helper defaults `fetchImpl` to the global `fetch`, so normal callers
// never have to pass it — but it's still overridable, which is what makes
// these easy to unit test (pass a fake fetch instead of hitting the network).

/** GET request. No body — use `queries` in options for query-string params. */
export function get<T, S = unknown>(
  uri: URL | string,
  options?: HelperOptions,
  fetchImpl: typeof fetch = fetch
): Promise<RequestResult<T, S>> {
  return request<T, S>(fetchImpl, uri, "GET", options);
}

/** HEAD request. `data` is always `null` on success — only status/headers matter. */
export function head<T = null, S = unknown>(
  uri: URL | string,
  options?: HelperOptions,
  fetchImpl: typeof fetch = fetch
): Promise<RequestResult<T, S>> {
  return request<T, S>(fetchImpl, uri, "HEAD", options);
}

/** OPTIONS request. Named `httpOptions` to avoid colliding with the `RequestOptions` type / `options` params used everywhere else in this file. */
export function httpOptions<T, S = unknown>(
  uri: URL | string,
  options?: HelperOptions,
  fetchImpl: typeof fetch = fetch
): Promise<RequestResult<T, S>> {
  return request<T, S>(fetchImpl, uri, "OPTIONS", options);
}

/** POST request with a body. `body` can be a plain object (auto-JSON-encoded) or a pre-serialized string. */
export function post<T, S = unknown>(
  uri: URL | string,
  body?: unknown,
  options?: HelperOptions,
  fetchImpl: typeof fetch = fetch
): Promise<RequestResult<T, S>> {
  return request<T, S>(fetchImpl, uri, "POST", { ...options, body });
}

/** PUT request with a body. */
export function put<T, S = unknown>(
  uri: URL | string,
  body?: unknown,
  options?: HelperOptions,
  fetchImpl: typeof fetch = fetch
): Promise<RequestResult<T, S>> {
  return request<T, S>(fetchImpl, uri, "PUT", { ...options, body });
}

/** PATCH request with a body. */
export function patch<T, S = unknown>(
  uri: URL | string,
  body?: unknown,
  options?: HelperOptions,
  fetchImpl: typeof fetch = fetch
): Promise<RequestResult<T, S>> {
  return request<T, S>(fetchImpl, uri, "PATCH", { ...options, body });
}

/**
 * DELETE request. `body` is optional — most DELETEs don't need one
 * (e.g. `DELETE /users/123`), but some APIs expect one (e.g. bulk-delete
 * with an id list). Named `del` because `delete` is a reserved word and
 * can't be used as a function name.
 */
export function del<T, S = unknown>(
  uri: URL | string,
  body?: unknown,
  options?: HelperOptions,
  fetchImpl: typeof fetch = fetch
): Promise<RequestResult<T, S>> {
  return request<T, S>(fetchImpl, uri, "DELETE", { ...options, body });
}

/** Grouped export, for `import { http } from "..."` + `http.get(...)` style usage. */
export const http = { get, post, put, patch, del, head, options: httpOptions };
