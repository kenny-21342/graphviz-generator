/**
 * Graphviz via WebAssembly.
 *
 * The API routes used to shell out to the native `dot` binary with
 * `child_process.execFile`, which meant the app could only be deployed to a
 * host where Graphviz was installed and on PATH. `@hpcc-js/wasm-graphviz`
 * ships the whole of Graphviz as a WASM module, so layout and rendering run
 * in-process and the app deploys anywhere Node runs — Vercel included.
 */

import { Graphviz } from "@hpcc-js/wasm-graphviz";

/** Layout engines the API is willing to run. */
export const ENGINES = ["dot", "neato", "fdp", "sfdp", "circo", "twopi"];

export const resolveEngine = (name) => (ENGINES.includes(name) ? name : "dot");

/** Error thrown when Graphviz rejects the supplied DOT source. */
export class GraphvizError extends Error {
  constructor(message) {
    super(message);
    this.name = "GraphvizError";
  }
}

// The WASM module is compiled and instantiated once per process and reused by
// every request. A failed load is not cached, so a transient failure does not
// permanently break the route.
let instance = null;

async function getGraphviz() {
  if (!instance) {
    instance = Graphviz.load().catch((err) => {
      instance = null;
      throw err;
    });
  }
  return instance;
}

/**
 * Lay out / render DOT source.
 *
 * @param {string} dotSource DOT-language graph.
 * @param {object} opts
 * @param {"svg"|"plain"} [opts.format] Output format.
 * @param {string} [opts.engine] Layout engine name (validated by `resolveEngine`).
 * @param {boolean} [opts.fixedPositions] Use the `pos` attributes already in the
 *   source instead of computing a layout — the WASM equivalent of `dot -n`.
 * @returns {Promise<string>} The rendered output.
 * @throws {GraphvizError} when the source is invalid or produces no output.
 */
export async function runGraphviz(dotSource, { format = "svg", engine = "dot", fixedPositions = false } = {}) {
  const graphviz = await getGraphviz();

  let out;
  try {
    // `layout` is synchronous inside the WASM module, so there is no
    // subprocess to time out or kill; a pathological graph blocks this
    // request only. The concurrency cap in guard.js still bounds how many
    // can run at once.
    out = graphviz.layout(dotSource, format, resolveEngine(engine), fixedPositions ? { nop: 1 } : undefined);
  } catch (err) {
    // Graphviz reports parse/layout problems as a thrown Error whose message
    // is the diagnostic ("syntax error in line 1 near '}'"). No filesystem
    // paths are involved, since nothing is ever written to disk.
    throw new GraphvizError(String(err?.message || err || "Graphviz failed"));
  }

  if (typeof out !== "string" || !out) {
    throw new GraphvizError("Graphviz produced no output.");
  }
  return out;
}
