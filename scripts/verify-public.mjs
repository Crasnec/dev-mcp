#!/usr/bin/env node
import assert from "node:assert/strict";

// Never print cookies, provider URLs, credentials, codes or response bodies.
const base = process.argv[2];
assert(
  base && new URL(base).protocol === "https:",
  "Pass the HTTPS service origin",
);
const request = (route, options = {}) =>
  fetch(base + route, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    ...options,
  });
try {
  for (const [route, status] of [
    ["/healthz", 200],
    ["/login", 200],
    ["/signup", 200],
    ["/assets/auth.css", 200],
    ["/assets/admin.css", 200],
    ["/admin", 303],
    ["/mcp", 401],
    ["/.well-known/oauth-authorization-server", 200],
  ]) {
    const response = await request(route);
    assert.equal(response.status, status, route + " status");
    console.log("PASS " + route + " " + status);
  }
  const signup = await request("/signup");
  assert.equal(
    signup.headers.get("referrer-policy"),
    "same-origin",
    "Native forms must preserve same-origin Origin headers",
  );
  assert(
    signup.headers
      .get("content-security-policy")
      ?.includes("form-action 'self' https://accounts.google.com;"),
    "Google form redirects must be allowed",
  );
  const html = await signup.text();
  assert(
    html.includes("Google로 가입하기"),
    "Google registration button missing",
  );
  assert(!html.includes('name="password"'), "Password registration is exposed");
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert(csrf, "Missing CSRF token");
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    origin: base,
    cookie,
  };
  const disabledSignup = await request("/signup", {
    method: "POST",
    headers,
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(
    disabledSignup.status,
    403,
    "Password registration must be disabled",
  );
  const started = await request("/auth/google", {
    method: "POST",
    headers,
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(started.status, 303, "Google login start failed");
  const google = new URL(started.headers.get("location"));
  assert.equal(google.origin, "https://accounts.google.com");
  assert.equal(
    google.searchParams.get("redirect_uri"),
    base + "/auth/google/callback",
  );
  assert.equal(google.searchParams.get("code_challenge_method"), "S256");
  assert(!google.searchParams.has("client_secret"));
  console.log(
    "PASS Google start, PKCE, callback URL and password-signup rejection",
  );
  const provider = await fetch(google, { signal: AbortSignal.timeout(20000) });
  const providerBody = await provider.text();
  const providerError = [
    "redirect_uri_mismatch",
    "invalid_client",
    "deleted_client",
    "org_internal",
  ].find((code) => providerBody.includes(code) || provider.url.includes(code));
  assert(!providerError, "Google rejected configuration: " + providerError);
  assert(
    provider.ok && !provider.url.includes("/signin/oauth/error"),
    "Google returned an authorization error",
  );
  console.log(
    "PASS Google sign-in page reachable (interactive account login still requires the user)",
  );
} catch (error) {
  console.error(
    "Public deployment verification failed: " +
      (error instanceof assert.AssertionError
        ? error.message.split("\n")[0]
        : "request failed"),
  );
  process.exitCode = 1;
}
