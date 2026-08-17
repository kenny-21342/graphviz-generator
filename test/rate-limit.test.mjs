import test from "node:test";
import assert from "node:assert/strict";

import {
  __reset,
  checkRenderRate,
  clientIp,
  consume,
} from "../app/api/_lib/rate-limit.js";

test.beforeEach(() => {
  __reset();
  delete process.env.GRAPHVIZ_RATE_LIMIT_PER_MINUTE;
  delete process.env.GRAPHVIZ_RATE_LIMIT_PER_HOUR;
});

test("consume enforces a fixed window and resets at the boundary", () => {
  assert.equal(consume("a", 1, 5_000, 1_000).allowed, true);
  const denied = consume("a", 1, 5_000, 5_999);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 1);
  assert.equal(consume("a", 1, 5_000, 6_000).allowed, true);
});

test("clientIp prefers the original forwarded address", () => {
  const request = {
    headers: new Headers({ "x-forwarded-for": "203.0.113.4, 10.0.0.2" }),
  };
  assert.equal(clientIp(request), "203.0.113.4");
  assert.equal(clientIp({ headers: new Headers() }), "unknown");
});

test("render and layout calls share the configured per-IP quota", () => {
  process.env.GRAPHVIZ_RATE_LIMIT_PER_MINUTE = "2";
  process.env.GRAPHVIZ_RATE_LIMIT_PER_HOUR = "10";
  const request = {
    headers: new Headers({ "x-real-ip": "198.51.100.8" }),
  };

  assert.equal(checkRenderRate(request, 1_000).allowed, true);
  assert.equal(checkRenderRate(request, 1_000).allowed, true);
  const denied = checkRenderRate(request, 1_000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 60);
});

test("a rejected hourly request does not consume the minute quota", () => {
  process.env.GRAPHVIZ_RATE_LIMIT_PER_MINUTE = "2";
  process.env.GRAPHVIZ_RATE_LIMIT_PER_HOUR = "1";
  const request = {
    headers: new Headers({ "x-real-ip": "192.0.2.12" }),
  };

  assert.equal(checkRenderRate(request, 1_000).allowed, true);
  const second = checkRenderRate(request, 1_000);
  const third = checkRenderRate(request, 1_000);
  assert.equal(second.allowed, false);
  assert.equal(second.retryAfter, 3_600);
  assert.deepEqual(third, second);
});
