import { execFile } from "child_process";
import { promisify } from "util";
import { access, constants } from "fs/promises";

const execFileAsync = promisify(execFile);

/** Layout engines the API is willing to run. */
export const ENGINES = ["dot", "neato", "fdp", "sfdp", "circo", "twopi"];

export const resolveEngine = (name) => (ENGINES.includes(name) ? name : "dot");

// Cache of resolved binary paths: name -> absolute path (or the bare name).
const resolved = new Map();

// Directories where Graphviz binaries commonly live, even when the user's
// login-shell PATH (and thus the PATH Node inherited at launch) does not
// include them. Order matters: we check the bare PATH first, then these.
const FALLBACK_DIRS = [
  "/opt/homebrew/bin", // Apple Silicon Homebrew
  "/usr/local/bin", // Intel Homebrew / manual installs
  "/usr/bin", // Linux distro packages
  "/opt/local/bin", // MacPorts
];

async function pathExists(p) {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a Graphviz binary (e.g. "dot", "neato") to an absolute path.
 *
 * `child_process.execFile` does NOT run a login shell, so the PATH that
 * Node sees is whatever the launching process had. When launched from an
 * IDE, GUI app, or service manager, that PATH frequently omits the
 * directory where Homebrew/MacPorts installed Graphviz
 * (e.g. /opt/homebrew/bin on Apple Silicon). The bare `dot` command then
 * fails with ENOENT even though `which dot` works in a terminal.
 *
 * This resolver:
 *   1. First trusts PATH and runs the bare command.
 *   2. On any *spawn* failure, probes FALLBACK_DIRS for an executable.
 *   3. Caches only successful resolutions.
 */
export async function resolveBinary(name) {
  if (resolved.has(name)) return resolved.get(name);

  // 1. Try the bare command via PATH.
  try {
    await execFileAsync(name, ["-V"]);
    resolved.set(name, name);
    return name;
  } catch (err) {
    // A numeric `code` is an exit status, which means the binary ran — some
    // builds exit non-zero for -V. A string code (ENOENT, EACCES, EAGAIN…)
    // is a spawn failure, so keep probing instead of caching a false hit.
    if (typeof err?.code === "number") {
      resolved.set(name, name);
      return name;
    }
  }

  // 2. Probe fallback directories for an executable file.
  for (const dir of FALLBACK_DIRS) {
    const candidate = `${dir}/${name}`;
    if (await pathExists(candidate)) {
      resolved.set(name, candidate);
      return candidate;
    }
  }

  // 3. Not found. Deliberately not cached: a transient spawn failure (EAGAIN
  //    under load) must not permanently mark the binary as missing.
  return name;
}

/**
 * Run a Graphviz binary, resolving its path first. Same API as
 * execFileAsync but with a `name` -> absolute-path resolution layer.
 */
export async function runGraphviz(name, args, options = {}) {
  const bin = await resolveBinary(name);
  return execFileAsync(bin, args, options);
}
