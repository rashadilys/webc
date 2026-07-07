export type HttpMethod =
  | "GET"
  | "POST"
  | "PATCH"
  | "PUT"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export type BodyEncoding = "json" | "text";

export type RequestOptions = {
  headers?: HeadersInit;
  /** Overwrite headers this function would otherwise set (Accept, Content-Type, Authorization) if the caller already supplied them. */
  overrideHeaders?: boolean;

  accept?: BodyEncoding;
  contentType?: BodyEncoding;

  mode?: "cors" | "no-cors" | "same-origin";
  credentials?: "include" | "omit" | "same-origin";
  keepalive?: boolean;

  bearerAuthorization?: string;
  queries?: Record<string, string | number | boolean>;
  body?: unknown;

  /** Milliseconds. Combined with `signal` if both are given. */
  timeout?: number;
  signal?: AbortSignal;
};

export enum ErrorType {
  /** Non-2xx HTTP status. */
  ResponseStatus = "ResponseStatus",
  /** The response body couldn't be parsed as the requested `accept` type. */
  ResponseParse = "ResponseParse",
  /** The outgoing `body` couldn't be encoded as the requested `contentType`. */
  RequestBodyEncoding = "RequestBodyEncoding",
  /** Timed out (via `timeout` option or caller's own signal). */
  Aborted = "Aborted",
  /** Connection-level failure — DNS, offline, refused, CORS-blocked, etc. */
  Network = "Network",
  /** Anything else. */
  Unknown = "Unknown",
}

export type RequestSuccess<T> = {
  ok: true;
  status: number;
  headers: Headers;
  data: T;
};

export type RequestFailure<S> = {
  ok: false;
  status: number;
  headers: Headers | null;
  error: string;
  errorType: ErrorType;
  errorBody: S | null;
  /** The underlying thrown value, if any — for logging, never for control flow. */
  cause?: unknown;
};

export type RequestResult<T, S> = RequestSuccess<T> | RequestFailure<S>;

const MIME = {
  json: "application/json",
  text: "text/plain",
} as const;

const METHODS_WITH_BODY = new Set<HttpMethod>([
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
]);

function fail<S>(
  status: number,
  errorType: ErrorType,
  error: string,
  headers: Headers | null = null,
  errorBody: S | null = null,
  cause?: unknown
): RequestFailure<S> {
  return { ok: false, status, headers, error, errorType, cause, errorBody };
}

function encodeBody(
  body: unknown,
  type: BodyEncoding
): { ok: true; value: BodyInit } | { ok: false; error: string } {
  if (type === "text") {
    if (typeof body !== "string") {
      return {
        ok: false,
        error: `contentType is "text" but the body is a ${typeof body}, not a string`,
      };
    }
    return { ok: true, value: body };
  }

  // json
  if (typeof body === "string") {
    // Assume the caller already serialized it themselves.
    return { ok: true, value: body };
  }
  try {
    return { ok: true, value: JSON.stringify(body) };
  } catch {
    return {
      ok: false,
      error:
        "Request body contains a circular reference or cannot be JSON-serialized",
    };
  }
}

async function parseResponse<T>(
  response: Response,
  accept: BodyEncoding
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    if (accept === "json") {
      // An empty body is valid for many 204/205 responses; don't treat it as a parse failure.
      const raw = await response.text();
      if (raw.length === 0) return { ok: true, data: null as T };
      return { ok: true, data: JSON.parse(raw) as T };
    }
    return { ok: true, data: (await response.text()) as unknown as T };
  } catch (err: any) {
    return {
      ok: false,
      error: `Failed to parse response as ${accept}: ${err?.message ?? err}`,
    };
  }
}

function classifyThrown(err: any): { errorType: ErrorType; error: string } {
  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    return {
      errorType: ErrorType.Aborted,
      error: "Request was aborted or timed out",
    };
  }

  const msg = String(err?.message ?? "").toLowerCase();
  const looksLikeNetworkFailure =
    err instanceof TypeError &&
    (msg.includes("networkerror") ||
      msg.includes("failed to fetch") ||
      msg.includes("fetch failed") ||
      msg.includes("load failed"));

  if (looksLikeNetworkFailure || err?.code === "ECONNREFUSED") {
    return { errorType: ErrorType.Network, error: "Network request failed" };
  }

  return {
    errorType: ErrorType.Unknown,
    error: err?.message ?? "Unknown request error",
  };
}

function buildHeaders(options: RequestOptions | undefined): Headers {
  const headers = new Headers(options?.headers);
  const override = !!options?.overrideHeaders;

  const setUnlessPresent = (key: string, value: string) => {
    if (override || !headers.has(key)) headers.set(key, value);
  };

  if (options?.bearerAuthorization) {
    setUnlessPresent("Authorization", `Bearer ${options.bearerAuthorization}`);
  }
  setUnlessPresent("Accept", MIME[options?.accept ?? "json"]);

  return headers;
}

function buildUrl(uri: URL | string, queries?: RequestOptions["queries"]): URL {
  const url = uri instanceof URL ? new URL(uri.toString()) : new URL(uri);
  if (queries) {
    for (const [key, value] of Object.entries(queries)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function combineSignals(
  a?: AbortSignal,
  b?: AbortSignal
): AbortSignal | undefined {
  if (a && b && typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any([a, b]);
  }

  if (!a) return b;
  if (!b) return a;

  return a;
}

export async function request<T, S>(
  fetchImpl: typeof fetch,
  uri: URL | string,
  method: HttpMethod,
  options?: RequestOptions
): Promise<RequestResult<T, S>> {
  const url = buildUrl(uri, options?.queries);
  const headers = buildHeaders(options);
  const accept = options?.accept ?? "json";
  const contentType = options?.contentType ?? "json";

  let bodyInit: BodyInit | undefined;

  if (METHODS_WITH_BODY.has(method) && options?.body !== undefined) {
    const encoded = encodeBody(options.body, contentType);
    if (!encoded.ok) {
      return fail(0, ErrorType.RequestBodyEncoding, encoded.error);
    }
    bodyInit = encoded.value;

    const override = !!options?.overrideHeaders;
    if (override || !headers.has("Content-Type")) {
      headers.set("Content-Type", MIME[contentType]);
    }
  }

  const timeoutSignal =
    options?.timeout && options.timeout > 0
      ? AbortSignal.timeout(options.timeout)
      : undefined;
  const signal = combineSignals(timeoutSignal, options?.signal);

  let response: Response;

  try {
    response = await fetchImpl(url, {
      method,
      headers,
      credentials: options?.credentials ?? "omit",
      mode: options?.mode ?? "cors",
      keepalive: !!options?.keepalive,
      signal,
      body: bodyInit,
    });
  } catch (err: any) {
    const { errorType, error } = classifyThrown(err);
    return fail(0, errorType, error, null, null, err);
  }

  // HEAD does not need handling with body
  if (response.status === 204 || response.status === 205) {
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      data: null as T,
    };
  }

  // HEAD method no need to attemp body parsing
  if (method === "HEAD") {
    if (!response.ok) {
      return fail(
        response.status,
        ErrorType.ResponseParse,
        `Request failed with status ${response.status}`,
        response.headers
      );
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      data: null as T,
    };
  }

  const parsed = await parseResponse<T>(response, accept);

  if (!parsed.ok) {
    return fail(
      response.status,
      ErrorType.ResponseParse,
      parsed.error,
      response.headers
    );
  }

  if (!response.ok) {
    return fail(
      response.status,
      ErrorType.ResponseStatus,
      `Request failed with status ${response.status}`,
      response.headers,
      parsed.data as unknown as S
    );
  }

  return {
    ok: true,
    status: response.status,
    headers: response.headers,
    data: parsed.data,
  };
}
