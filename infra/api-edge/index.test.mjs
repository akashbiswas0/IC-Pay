import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { upstreamRequest, proxyResponse } from "./index.mjs";
const origin = "https://senior-train-gracious.ngrok-free.dev";
const event = {
  rawPath: "/v1/webhooks/multibaas",
  rawQueryString: "x=%2B&x=2&space=a%20b",
  headers: {
    authorization: "Bearer test-capability",
    origin: "https://app.example",
    "content-type": "application/json",
    host: "attacker.example",
    "content-length": "1",
    "x-multibaas-signature": "signature",
  },
  requestContext: { http: { method: "POST" } },
};
test("proxy preserves exact binary request bytes, query, authentication and webhook HMAC input", () => {
  const raw = Buffer.from('{ "message": "\u65e5\u672c", "x": 1 }\n');
  const input = {
    ...event,
    body: raw.toString("base64"),
    isBase64Encoded: true,
    cookies: ["one=1", "two=2"],
  };
  const request = upstreamRequest(input, origin);
  assert.equal(
    request.url,
    origin + "/v1/webhooks/multibaas?" + event.rawQueryString,
  );
  assert.deepEqual(request.options.body, raw);
  assert.equal(
    createHmac("sha256", "test-only")
      .update(request.options.body)
      .digest("hex"),
    createHmac("sha256", "test-only").update(raw).digest("hex"),
  );
  assert.equal(
    request.options.headers.get("authorization"),
    event.headers.authorization,
  );
  assert.equal(request.options.headers.get("cookie"), "one=1; two=2");
  assert.equal(request.options.headers.get("origin"), event.headers.origin);
  assert.equal(request.options.headers.get("host"), null);
  assert.equal(request.options.headers.get("content-length"), null);
  assert.equal(request.options.headers.get("ngrok-skip-browser-warning"), "1");
  assert.equal(request.options.redirect, "manual");
});
test("bodyless POST receives no invented JSON content type", () => {
  const request = upstreamRequest(
    { ...event, rawPath: "/v1/logout", rawQueryString: "", headers: {} },
    origin,
  );
  assert.equal(request.options.body, undefined);
  assert.equal(request.options.headers.get("content-type"), null);
});
test("proxy cannot target another host or escape the API prefix", () => {
  for (const rawPath of [
    "/",
    "/verify",
    "//evil.example/v1/me",
    "/v1/../private",
    "/v1/%2e%2e/private",
    "/v1/\\evil",
    "/health?x=1",
  ])
    assert(upstreamRequest({ ...event, rawPath }, origin).rejected);
  assert.throws(() => upstreamRequest(event, "http://localhost"));
  assert(
    upstreamRequest(
      { ...event, requestContext: { http: { method: "CONNECT" } } },
      origin,
    ).rejected,
  );
});
test("response mapping preserves separate cookies and disables cache without forwarding stale encoding or length", async () => {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "public, max-age=60",
    "content-length": "999",
    "content-encoding": "gzip",
    vary: "Origin",
  });
  headers.append("set-cookie", "first=one; Secure; HttpOnly");
  headers.append("set-cookie", "second=two; Secure; HttpOnly");
  const result = await proxyResponse(
    new Response('{"ok":true}', { status: 200, headers }),
    "GET",
  );
  assert.equal(result.headers["cache-control"], "private, no-store");
  assert.equal(result.cookies.length, 2);
  assert.equal(result.headers["content-length"], undefined);
  assert.equal(result.headers["content-encoding"], undefined);
  assert.equal(Buffer.from(result.body, "base64").toString(), '{"ok":true}');
  assert.equal(
    (
      await proxyResponse(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example" },
        }),
        "GET",
      )
    ).statusCode,
    502,
  );
});

const internalOrigin =
  "http://internal-suica-api-123.us-east-1.elb.amazonaws.com";
test("HTTP requires explicit private ALB mode, strict region/hostname and default port", () => {
  assert.throws(() => upstreamRequest(event, internalOrigin));
  assert.throws(() => upstreamRequest(event, internalOrigin, "internal"));
  for (const candidate of [
    "http://localhost",
    "http://127.0.0.1",
    "http://169.254.169.254",
    "http://internal-suica-api-123.us-west-2.elb.amazonaws.com",
    "http://suica-api-123.us-east-1.elb.amazonaws.com",
    internalOrigin + ".evil.example",
    "http://internal-.us-east-1.elb.amazonaws.com",
    internalOrigin + ":8080",
    internalOrigin + ":443",
    internalOrigin + "/v1",
    internalOrigin + "?x=1",
    internalOrigin + "#x",
    internalOrigin + "/v1/..",
    internalOrigin + "?",
    internalOrigin + "#",
    internalOrigin.replace("http://", "http://user:secret@"),
  ])
    assert.throws(
      () => upstreamRequest(event, candidate, "internal-alb"),
      candidate,
    );
  for (const candidate of [
    internalOrigin,
    internalOrigin + ":80",
    internalOrigin + "/",
  ]) {
    const result = upstreamRequest(event, candidate, "internal-alb");
    assert.equal(new URL(result.url).origin, internalOrigin);
    assert.equal(
      result.options.headers.get("ngrok-skip-browser-warning"),
      null,
    );
  }
  assert.equal(
    new URL(upstreamRequest(event, "https://api.example", "internal-alb").url)
      .origin,
    "https://api.example",
  );
});
test("only validated gateway source IP becomes the forwarded client IP", () => {
  for (const sourceIp of ["203.0.113.42", "2001:db8::42"]) {
    const request = upstreamRequest(
      {
        ...event,
        headers: {
          ...event.headers,
          "X-Forwarded-For": "attacker, forged",
          Forwarded: "for=attacker",
          "X-Real-IP": "forged",
          "ngrok-skip-browser-warning": "spoof",
        },
        requestContext: { http: { method: "POST", sourceIp } },
        body: "exact body\n",
        cookies: ["session=opaque; value=unaltered"],
      },
      internalOrigin,
      "internal-alb",
    );
    assert.equal(request.options.headers.get("x-forwarded-for"), sourceIp);
    assert.equal(request.options.headers.get("forwarded"), null);
    assert.equal(request.options.headers.get("x-real-ip"), null);
    assert.equal(
      request.options.headers.get("ngrok-skip-browser-warning"),
      null,
    );
    assert.equal(
      request.options.headers.get("authorization"),
      event.headers.authorization,
    );
    assert.equal(
      request.options.headers.get("cookie"),
      "session=opaque; value=unaltered",
    );
    assert.deepEqual(request.options.body, Buffer.from("exact body\n"));
  }
  for (const sourceIp of [
    undefined,
    null,
    123,
    "",
    "not-an-ip",
    "203.0.113.42, 192.0.2.1",
    "203.0.113.42:443",
    "203.0.113.42\r\nx-injected: value",
  ]) {
    const request = upstreamRequest(
      {
        ...event,
        headers: { "x-forwarded-for": "forged" },
        requestContext: { http: { method: "POST", sourceIp } },
      },
      internalOrigin,
      "internal-alb",
    );
    assert.equal(request.options.headers.get("x-forwarded-for"), null);
  }
});
test("ngrok bypass header is limited to ngrok domains", () => {
  for (const host of [
    "tunnel.ngrok-free.dev",
    "tunnel.ngrok-free.app",
    "tunnel.ngrok.app",
    "tunnel.ngrok.io",
  ])
    assert.equal(
      upstreamRequest(event, "https://" + host).options.headers.get(
        "ngrok-skip-browser-warning",
      ),
      "1",
    );
  for (const host of [
    "api.example",
    "ngrok-free.dev.evil.example",
    "notngrok.io",
  ])
    assert.equal(
      upstreamRequest(event, "https://" + host).options.headers.get(
        "ngrok-skip-browser-warning",
      ),
      null,
    );
});
