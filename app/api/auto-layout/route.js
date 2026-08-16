import { NextResponse } from "next/server";
import { writeFile, readFile, mkdtemp, rm, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { resolveEngine, runGraphviz } from "../_lib/graphviz";
import {
  BusyError,
  errorPayload,
  internalError,
  sanitizeStderr,
  validateDotPayload,
  withRenderSlot,
} from "../_lib/guard";
import { parsePlain, toPixelLayout } from "../_lib/plain";

// Spawns a subprocess and touches the filesystem — cannot run on the edge.
export const runtime = "nodejs";

const DOT_TIMEOUT_MS = 20000;
const PX_PER_INCH = 72;
const MARGIN = 40;

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function POST(request) {
  let tempDir = null;
  try {
    const body = await request.json().catch(() => ({}));
    const { dotCode, engine } = body;

    const valid = validateDotPayload(dotCode);
    if (!valid.ok) return valid.response;

    const engineBin = resolveEngine(engine);

    return await withRenderSlot(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "gv-layout-"));
      const inFile = join(tempDir, "graph.gv");
      const outFile = join(tempDir, "graph.plain");
      await writeFile(inFile, dotCode, "utf-8");

      const result = await runGraphviz(engineBin, ["-Tplain", "-o", outFile, inFile], {
        timeout: DOT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      }).catch((err) => ({ error: err, stderr: err.stderr || "" }));

      if (result.error) {
        if (result.error.code === "ENOENT") {
          return errorPayload("Graphviz is not configured on this server.", 500, {
            details: `Install Graphviz and make the \`${engineBin}\` binary available on PATH.`,
          });
        }
        if (result.error.killed) {
          return errorPayload("The layout took too long to compute.", 504, {
            details: `Layout was stopped after ${DOT_TIMEOUT_MS / 1000} seconds.`,
          });
        }
        return errorPayload("The layout engine rejected this diagram.", 400, {
          rawOutput: sanitizeStderr(result.stderr, { syntaxOnly: true, redact: [inFile, tempDir] }),
        });
      }

      if (!(await fileExists(outFile))) {
        return errorPayload("The layout engine produced no output.", 500, {
          rawOutput: sanitizeStderr(result.stderr, { redact: [inFile, tempDir] }),
        });
      }

      const parsed = parsePlain(await readFile(outFile, "utf-8"));
      const { layout, bounds } = toPixelLayout(parsed, {
        pxPerInch: PX_PER_INCH,
        margin: MARGIN,
      });

      return NextResponse.json({ success: true, engine: engineBin, layout, bounds });
    });
  } catch (error) {
    if (error instanceof BusyError) {
      return errorPayload(error.message, 503);
    }
    return internalError("Auto-layout error", error);
  } finally {
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
