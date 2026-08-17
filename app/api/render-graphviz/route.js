import { NextResponse } from "next/server";

import { GraphvizError, resolveEngine, runGraphviz } from "../_lib/graphviz";
import {
  BusyError,
  errorPayload,
  internalError,
  sanitizeStderr,
  validateDotPayload,
  withRenderSlot,
} from "../_lib/guard";
import { checkRenderRate } from "../_lib/rate-limit";

// Graphviz runs as a WASM module in-process: no subprocess, no temp files, so
// this deploys to a serverless host as-is. It still needs the Node runtime
// (the edge runtime cannot instantiate this module).
export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { dotCode, engine, fixedPositions } = body;

    const valid = validateDotPayload(dotCode);
    if (!valid.ok) return valid.response;

    const rate = checkRenderRate(request);
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Too many Graphviz requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
      );
    }

    const engineName = resolveEngine(engine);

    return await withRenderSlot(async () => {
      let svg;
      try {
        // `fixedPositions` is the WASM equivalent of `dot -n`: use the `pos`
        // attributes already in the source instead of computing a layout,
        // which is how the canvas arrangement is reproduced exactly.
        svg = await runGraphviz(dotCode, {
          format: "svg",
          engine: engineName,
          fixedPositions: fixedPositions === true,
        });
      } catch (err) {
        if (err instanceof GraphvizError) {
          return errorPayload("Graphviz could not render this diagram.", 400, {
            rawOutput: sanitizeStderr(err.message, { syntaxOnly: true }),
          });
        }
        throw err;
      }

      // The WASM build renders SVG (and other vector/text formats) but not
      // PNG, which needs the native raster plugins. SVG is returned instead —
      // it is resolution-independent and smaller for typical diagrams.
      //
      // Always a data: URI, so the client can only ever put it in an <img>.
      // Inlining Graphviz SVG into the DOM would make HTML-like labels a
      // script-injection vector.
      const base64 = Buffer.from(svg, "utf-8").toString("base64");
      return NextResponse.json({
        success: true,
        format: "svg",
        image: `data:image/svg+xml;base64,${base64}`,
      });
    });
  } catch (error) {
    if (error instanceof BusyError) {
      return errorPayload(error.message, 503);
    }
    return internalError("Graphviz render error", error);
  }
}
