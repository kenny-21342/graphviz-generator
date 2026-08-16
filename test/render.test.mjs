/**
 * Integration tests: the generated DOT must actually parse and render.
 *
 * These caught the bug where graph-level attributes were emitted as a bare
 * `[rankdir="TB"]`, which is a syntax error, so every graph the app produced
 * failed to render. Skipped automatically when Graphviz is not installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { generateDot } from "../app/lib/dot.js";

const execFileAsync = promisify(execFile);

let hasDot = true;
try {
  await execFileAsync("dot", ["-V"]);
} catch {
  hasDot = false;
}

const node = (over = {}) => ({
  id: "node_1",
  shape: "box",
  label: "N1",
  x: 100,
  y: 80,
  width: 110,
  height: 50,
  strokeColor: "#0f172a",
  fillColor: "transparent",
  fontColor: "#0f172a",
  fontSize: 13,
  lineWidth: 1.5,
  style: "solid",
  clusterId: null,
  ...over,
});

const SAMPLE = {
  nodes: [
    node({ id: "node_1", shape: "rounded", label: "Start", x: 200, y: 80, fillColor: "#dbeafe", clusterId: "cluster_1" }),
    node({ id: "node_2", shape: "circle", label: "Hub", x: 200, y: 300, radius: 38, clusterId: "cluster_1" }),
    node({ id: "node_3", shape: "diamond", label: "Choose\\nwisely", x: 460, y: 300, style: "dashed", fillColor: "#fef3c7" }),
    node({ id: "node_4", shape: "record", label: "a|b", x: 700, y: 300 }),
    node({ id: "graph", shape: "box", label: "reserved word", x: 900, y: 300 }),
  ],
  edges: [
    { id: "e1", source: "node_1", target: "node_2", label: "go", dir: "forward", style: "solid", arrowhead: "normal", penwidth: 1.5, fontSize: 11 },
    { id: "e2", source: "node_2", target: "node_3", label: "", dir: "none", style: "dashed", arrowhead: "vee", penwidth: 2, fontSize: 11 },
    { id: "e3", source: "node_3", target: "graph", label: "", dir: "both", style: "solid", arrowhead: "normal", penwidth: 1.5, fontSize: 11 },
  ],
  clusters: [{ id: "cluster_1", label: "Group A", color: "#94a3b8", bgColor: "#f8fafc" }],
};

const baseAttrs = {
  engine: "dot",
  rankdir: "TB",
  splines: "spline",
  bgcolor: "#ffffff",
  fontname: "Helvetica",
  nodesep: 0.5,
  ranksep: 0.75,
};

function render(dotSource, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("dot", args);
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString();
      if (code !== 0) reject(new Error(`dot exited ${code}: ${stderr}`));
      else resolve({ stdout: Buffer.concat(out), stderr });
    });
    child.stdin.end(dotSource);
  });
}

test("pinned-position DOT renders with -Kneato -n", { skip: !hasDot && "graphviz not installed" }, async () => {
  const dotSource = generateDot({ ...SAMPLE, graphAttrs: { ...baseAttrs, preservePositions: true } });
  const { stdout, stderr } = await render(dotSource, ["-Kneato", "-n", "-Tpng"]);
  assert.equal(stderr.trim(), "");
  assert.ok(stdout.length > 100, "produced a PNG");
  assert.equal(stdout.subarray(1, 4).toString(), "PNG");
});

test("engine-laid-out DOT renders with plain dot", { skip: !hasDot && "graphviz not installed" }, async () => {
  const dotSource = generateDot({ ...SAMPLE, graphAttrs: { ...baseAttrs, preservePositions: false } });
  const { stdout, stderr } = await render(dotSource, ["-Tpng"]);
  assert.equal(stderr.trim(), "");
  assert.equal(stdout.subarray(1, 4).toString(), "PNG");
});

test("pinned positions survive the round trip through -Tplain", { skip: !hasDot && "graphviz not installed" }, async () => {
  const dotSource = generateDot({ ...SAMPLE, graphAttrs: { ...baseAttrs, preservePositions: true } });
  const { stdout } = await render(dotSource, ["-Kneato", "-n", "-Tplain"]);
  const { parsePlain, toPixelLayout } = await import("../app/api/_lib/plain.js");
  const { layout } = toPixelLayout(parsePlain(stdout.toString()), { margin: 0 });

  const byId = new Map(layout.map((n) => [n.id, n]));
  // node_1 is at canvas y=80 and node_2 at y=300, so node_1 must stay above it.
  assert.ok(byId.get("node_1").y < byId.get("node_2").y);
  // Both share canvas x=200, so their laid-out x must match too.
  assert.equal(byId.get("node_1").x, byId.get("node_2").x);
  // Relative horizontal order is preserved.
  assert.ok(byId.get("node_2").x < byId.get("node_3").x);
});

test("every graph attribute combination stays parseable", { skip: !hasDot && "graphviz not installed" }, async () => {
  for (const preservePositions of [true, false]) {
    for (const splines of ["spline", "ortho", "line"]) {
      const dotSource = generateDot({
        ...SAMPLE,
        graphAttrs: { ...baseAttrs, splines, bgcolor: "#f0f0f0", preservePositions },
      });
      const args = preservePositions ? ["-Kneato", "-n", "-Tsvg"] : ["-Tsvg"];
      const { stdout } = await render(dotSource, args);
      assert.ok(stdout.toString().includes("<svg"), `svg for splines=${splines}`);
    }
  }
});
