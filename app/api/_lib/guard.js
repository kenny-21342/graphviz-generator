/**
 * Request guards for the endpoints that hand user-supplied DOT to Graphviz.
 */

import { NextResponse } from "next/server";

/** Largest DOT source we will lay out. */
export const MAX_DOT_BYTES = 256 * 1024;

/** Concurrent Graphviz layouts allowed across all requests. */
const MAX_CONCURRENT = 4;
/** How long a request will wait for a slot before giving up. */
const QUEUE_TIMEOUT_MS = 15000;

const isProd = process.env.NODE_ENV === "production";

/**
 * Attributes that make Graphviz read a file from the server's filesystem.
 * The DOT source is fully user-controlled and this endpoint is
 * unauthenticated, so they are refused rather than sandboxed.
 */
const FILE_REFERENCE_ATTRS = [
  "image",
  "imagepath",
  "shapefile",
  "fontpath",
  "epsf",
  "stylesheet",
];

const FILE_REFERENCE_RE = new RegExp(
  `(^|[^A-Za-z0-9_])(${FILE_REFERENCE_ATTRS.join("|")})\\s*=`,
  "i"
);

/**
 * Validate a DOT payload. Returns `{ ok: true, dotCode }` or
 * `{ ok: false, response }` with a ready-to-return error.
 */
export function validateDotPayload(dotCode) {
  if (typeof dotCode !== "string" || !dotCode.trim()) {
    return { ok: false, response: errorPayload("No DOT code provided.", 400) };
  }

  const bytes = Buffer.byteLength(dotCode, "utf-8");
  if (bytes > MAX_DOT_BYTES) {
    return {
      ok: false,
      response: errorPayload("The diagram is too large to render.", 413, {
        details: `The DOT source is ${Math.round(bytes / 1024)} KB; the limit is ${
          MAX_DOT_BYTES / 1024
        } KB.`,
      }),
    };
  }

  const match = dotCode.match(FILE_REFERENCE_RE);
  if (match) {
    return {
      ok: false,
      response: errorPayload("That diagram uses an unsupported attribute.", 400, {
        details: `\`${match[2]}\` makes Graphviz read files from the server and is not allowed.`,
      }),
    };
  }

  return { ok: true, dotCode };
}

/* ---------- concurrency ---------- */

let active = 0;
const waiters = [];

function releaseSlot() {
  active -= 1;
  const next = waiters.shift();
  if (next) {
    active += 1;
    next.resolve();
  }
}

/**
 * Run `fn` while holding one of a fixed number of render slots, so a burst of
 * requests cannot start unbounded concurrent Graphviz layouts.
 */
export async function withRenderSlot(fn) {
  if (active >= MAX_CONCURRENT) {
    const waiter = {};
    const queued = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    waiters.push(waiter);
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter);
      if (idx !== -1) waiters.splice(idx, 1);
      waiter.reject(new BusyError());
    }, QUEUE_TIMEOUT_MS);
    try {
      await queued;
    } finally {
      clearTimeout(timer);
    }
  } else {
    active += 1;
  }

  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

export class BusyError extends Error {
  constructor() {
    super("The renderer is busy. Try again in a moment.");
    this.name = "BusyError";
  }
}

/* ---------- responses ---------- */

export function errorPayload(error, status = 500, extra = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

/**
 * Graphviz's stderr names the offending line, which is genuinely useful for a
 * malformed diagram — but it can also echo server paths, so it is trimmed to
 * the parser diagnostics and withheld in production for non-syntax failures.
 */
export function sanitizeStderr(stderr, { syntaxOnly = false, redact = [] } = {}) {
  const text = (stderr || "").trim();
  if (!text) return null;
  if (isProd && !syntaxOnly) return null;

  const lines = text
    .split("\n")
    .map((line) => {
      // Graphviz prefixes diagnostics with the temp file it was given, e.g.
      // "Error: /var/folders/…/graph.gv: syntax error in line 3". Redact the
      // path but keep the diagnostic — it is the whole point of showing this.
      let out = line.trim();
      for (const path of redact) {
        if (path) out = out.split(path).join("your diagram");
      }
      return out;
    })
    .filter(Boolean)
    // Anything still naming a filesystem path is dropped entirely.
    .filter((l) => !/(^|\s|")(\/|[A-Za-z]:\\)\S+/.test(l))
    .slice(-20);

  return lines.length ? lines.join("\n") : null;
}

/** Log the real error server-side; return something safe to the client. */
export function internalError(scope, error) {
  console.error(`${scope}:`, error);
  return errorPayload("Something went wrong while rendering.", 500);
}
