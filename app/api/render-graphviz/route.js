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

// Spawns a subprocess and touches the filesystem — cannot run on the edge.
export const runtime = "nodejs";

const DOT_TIMEOUT_MS = 20000;

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
    const { dotCode, format, engine, fixedPositions } = body;

    const valid = validateDotPayload(dotCode);
    if (!valid.ok) return valid.response;

    const outFormat = format === "svg" ? "svg" : "png";
    const engineBin = resolveEngine(engine);

    // `-n` tells the engine to use the `pos` attributes already in the source
    // instead of computing a layout, which is how the canvas arrangement is
    // reproduced exactly.
    const args = [`-T${outFormat}`];
    if (fixedPositions === true) args.push("-n");

    return await withRenderSlot(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "gv-render-"));
      const inFile = join(tempDir, "graph.gv");
      const outFile = join(tempDir, `graph.${outFormat}`);
      await writeFile(inFile, dotCode, "utf-8");

      const result = await runGraphviz(engineBin, [...args, "-o", outFile, inFile], {
        timeout: DOT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      }).catch((err) => ({ error: err, stderr: err.stderr || "" }));

      if (result.error) {
        if (result.error.code === "ENOENT") {
          return errorPayload("Graphviz rendering is not configured on this server.", 500, {
            details: `Install Graphviz and make the \`${engineBin}\` binary available on PATH.`,
          });
        }
        if (result.error.killed) {
          return errorPayload("The diagram took too long to render.", 504, {
            details: `Rendering was stopped after ${DOT_TIMEOUT_MS / 1000} seconds.`,
          });
        }
        return errorPayload("Graphviz could not render this diagram.", 400, {
          rawOutput: sanitizeStderr(result.stderr, { syntaxOnly: true, redact: [inFile, tempDir] }),
        });
      }

      if (!(await fileExists(outFile))) {
        return errorPayload("Graphviz produced no output file.", 500, {
          rawOutput: sanitizeStderr(result.stderr, { redact: [inFile, tempDir] }),
        });
      }

      const buf = await readFile(outFile);
      const mime = outFormat === "svg" ? "image/svg+xml" : "image/png";
      // Always a data: URI, so the client can only ever put it in an <img>.
      // Inlining Graphviz SVG into the DOM would make HTML-like labels a
      // script-injection vector.
      return NextResponse.json({
        success: true,
        format: outFormat,
        image: `data:${mime};base64,${buf.toString("base64")}`,
      });
    });
  } catch (error) {
    if (error instanceof BusyError) {
      return errorPayload(error.message, 503);
    }
    return internalError("Graphviz render error", error);
  } finally {
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
