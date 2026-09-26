import { isIP } from "node:net";

const requestHeaders = new Set([
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
  "origin",
  "user-agent",
  "access-control-request-method",
  "access-control-request-headers",
  "x-multibaas-signature",
  "x-multibaas-timestamp",
]);
const responseHeaders = new Set([
  "content-type",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  "retry-after",
  "www-authenticate",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);
const noStore = {
  "cache-control": "private, no-store",
  vary: "Origin, Cookie, Authorization",
};
function error(statusCode, code, message) {
  return {
    statusCode,
    headers: { ...noStore, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: { code, message } }),
    isBase64Encoded: false,
  };
}

export function upstreamRequest(event, origin, mode = "https") {
  const base = new URL(origin);
  const privateALB =
    mode === "internal-alb" &&
    base.protocol === "http:" &&
    typeof origin === "string" &&
    /^http:\/\/internal-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.us-east-1\.elb\.amazonaws\.com(?::80)?\/?$/i.test(
      origin,
    ) &&
    /^internal-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.us-east-1\.elb\.amazonaws\.com$/.test(
      base.hostname,
    ) &&
    base.port === "";
  if (
    (base.protocol !== "https:" && !privateALB) ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw new Error("Invalid fixed upstream origin");
  const path = event.rawPath;
  if (
    typeof path !== "string" ||
    path.length > 4096 ||
    /[\\\r\n?#]/.test(path) ||
    !(path === "/health" || path.startsWith("/v1/"))
  )
    return { rejected: error(404, "not_found", "This path is not available.") };
  const target = new URL(path, base);
  if (
    target.origin !== base.origin ||
    !(target.pathname === "/health" || target.pathname.startsWith("/v1/"))
  )
    return { rejected: error(404, "not_found", "This path is not available.") };
  const rawQuery = event.rawQueryString ?? "";
  if (
    typeof rawQuery !== "string" ||
    rawQuery.length > 8192 ||
    /[\r\n#]/.test(rawQuery)
  )
    return { rejected: error(400, "invalid_request", "Invalid query string.") };
  const method = event.requestContext?.http?.method;
  if (
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
      method,
    )
  )
    return {
      rejected: error(
        405,
        "method_not_allowed",
        "This HTTP method is not available.",
      ),
    };
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (requestHeaders.has(key.toLowerCase()) && typeof value === "string")
      headers.set(key, value);
  }
  if (Array.isArray(event.cookies) && event.cookies.length)
    headers.set("cookie", event.cookies.join("; "));
  // API Gateway supplies this value; caller-provided forwarding headers are never trusted.
  const sourceIP = event.requestContext?.http?.sourceIp;
  if (typeof sourceIP === "string" && isIP(sourceIP))
    headers.set("x-forwarded-for", sourceIP);
  if (
    /\.(?:ngrok-free\.dev|ngrok-free\.app|ngrok\.app|ngrok\.io)$/.test(
      base.hostname,
    )
  )
    headers.set("ngrok-skip-browser-warning", "1");
  const body =
    event.body === undefined || event.body === null
      ? undefined
      : Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
  if (body && body.length > 65536)
    return {
      rejected: error(413, "request_too_large", "Request body is too large."),
    };
  if (body?.length && ["GET", "HEAD"].includes(method))
    return {
      rejected: error(
        400,
        "invalid_request",
        "This method cannot include a request body.",
      ),
    };
  // No synthetic Content-Type, Host or Content-Length. The exact bytes preserve webhook HMACs.
  return {
    url: target.href + (rawQuery ? `?${rawQuery}` : ""),
    options: {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : body,
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
    },
  };
}

export async function proxyResponse(response, method) {
  if (response.status >= 300 && response.status < 400)
    return error(
      502,
      "upstream_redirect",
      "The API returned an unexpected redirect.",
    );
  const headers = { ...noStore };
  for (const [key, value] of response.headers)
    if (responseHeaders.has(key.toLowerCase()))
      headers[key.toLowerCase()] = value;
  const vary = [
    ...(response.headers.get("vary") ?? "").split(","),
    "Origin",
    "Cookie",
    "Authorization",
  ]
    .map((v) => v.trim())
    .filter(Boolean);
  headers.vary = vary.includes("*")
    ? "*"
    : [...new Map(vary.map((v) => [v.toLowerCase(), v])).values()].join(", ");
  const bytes =
    method === "HEAD"
      ? Buffer.alloc(0)
      : Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2 * 1024 * 1024)
    return error(
      502,
      "upstream_response_too_large",
      "The API response is too large.",
    );
  const cookies = response.headers.getSetCookie();
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: bytes.toString("base64"),
    isBase64Encoded: true,
  };
}

export async function handler(event) {
  try {
    const request = upstreamRequest(
      event,
      process.env.UPSTREAM_ORIGIN,
      process.env.UPSTREAM_MODE,
    );
    if (request.rejected) return request.rejected;
    const response = await fetch(request.url, request.options);
    return await proxyResponse(response, request.options.method);
  } catch (error) {
    // Never log event/body/header/error payloads: they may contain credentials or World proofs.
    const timeout =
      error?.name === "TimeoutError" || error?.name === "AbortError";
    return errorResponse(timeout);
  }
}
function errorResponse(timeout) {
  return error(
    timeout ? 504 : 502,
    timeout ? "upstream_timeout" : "upstream_unavailable",
    timeout
      ? "The API did not respond in time."
      : "The API is temporarily unavailable.",
  );
}
