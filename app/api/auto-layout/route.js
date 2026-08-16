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
import { parsePlain, toPixelLayout } from "../_lib/plain";

// Graphviz runs as a WASM module in-process: no subprocess, no temp files, so
// this deploys to a serverless host as-is. It still needs the Node runtime
// (the edge runtime cannot instantiate this module).
export const runtime = "nodejs";

const PX_PER_INCH = 72;
const MARGIN = 40;

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { dotCode, engine } = body;

    const valid = validateDotPayload(dotCode);
    if (!valid.ok) return valid.response;

    const engineName = resolveEngine(engine);

    return await withRenderSlot(async () => {
      let plain;
      try {
        plain = await runGraphviz(dotCode, { format: "plain", engine: engineName });
      } catch (err) {
        if (err instanceof GraphvizError) {
          return errorPayload("The layout engine rejected this diagram.", 400, {
            rawOutput: sanitizeStderr(err.message, { syntaxOnly: true }),
          });
        }
        throw err;
      }

      const parsed = parsePlain(plain);
      const { layout, bounds } = toPixelLayout(parsed, {
        pxPerInch: PX_PER_INCH,
        margin: MARGIN,
      });

      return NextResponse.json({ success: true, engine: engineName, layout, bounds });
    });
  } catch (error) {
    if (error instanceof BusyError) {
      return errorPayload(error.message, 503);
    }
    return internalError("Auto-layout error", error);
  }
}
