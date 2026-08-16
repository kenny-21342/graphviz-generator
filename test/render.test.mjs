/**
 * Integration tests: the generated DOT must actually parse and render.
 *
 * These caught the bug where graph-level attributes were emitted as a bare
 * `[rankdir="TB"]`, which is a syntax error, so every graph the app produced
 * failed to render. Graphviz runs as a WASM module, so these no longer depend
 * on a `dot` binary being installed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Graphviz } from "@hpcc-js/wasm-graphviz";

import { generateDot } from "../app/lib/dot.js";

const graphviz = await Graphviz.load();

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

/** @param {{format?: string, engine?: string, nop?: boolean}} opts */
function render(dotSource, { format = "svg", engine = "dot", nop = false } = {}) {
  return graphviz.layout(dotSource, format, engine, nop ? { nop: 1 } : undefined);
}

test("pinned-position DOT renders with neato + nop", async () => {
  const dotSource = generateDot({ ...SAMPLE, graphAttrs: { ...baseAttrs, preservePositions: true } });
  const svg = render(dotSource, { engine: "neato", nop: true });
  assert.ok(svg.includes("<svg"), "produced an SVG");
  assert.ok(svg.length > 100);
});

test("engine-laid-out DOT renders with plain dot", async () => {
  const dotSource = generateDot({ ...SAMPLE, graphAttrs: { ...baseAttrs, preservePositions: false } });
  const svg = render(dotSource);
  assert.ok(svg.includes("<svg"));
});

test("pinned positions survive the round trip through -Tplain", async () => {
  const dotSource = generateDot({ ...SAMPLE, graphAttrs: { ...baseAttrs, preservePositions: true } });
  const plain = render(dotSource, { format: "plain", engine: "neato", nop: true });
  const { parsePlain, toPixelLayout } = await import("../app/api/_lib/plain.js");
  const { layout } = toPixelLayout(parsePlain(plain), { margin: 0 });

  const byId = new Map(layout.map((n) => [n.id, n]));
  // node_1 is at canvas y=80 and node_2 at y=300, so node_1 must stay above it.
  assert.ok(byId.get("node_1").y < byId.get("node_2").y);
  // Both share canvas x=200, so their laid-out x must match too.
  assert.equal(byId.get("node_1").x, byId.get("node_2").x);
  // Relative horizontal order is preserved.
  assert.ok(byId.get("node_2").x < byId.get("node_3").x);
});

test("every graph attribute combination stays parseable", async () => {
  for (const preservePositions of [true, false]) {
    for (const splines of ["spline", "ortho", "line"]) {
      const dotSource = generateDot({
        ...SAMPLE,
        graphAttrs: { ...baseAttrs, splines, bgcolor: "#f0f0f0", preservePositions },
      });
      const svg = preservePositions
        ? render(dotSource, { engine: "neato", nop: true })
        : render(dotSource);
      assert.ok(svg.includes("<svg"), `svg for splines=${splines}`);
    }
  }
});

test("every supported layout engine produces a parseable plain layout", async () => {
  const dotSource = generateDot({ ...SAMPLE, graphAttrs: { ...baseAttrs, preservePositions: false } });
  const { parsePlain } = await import("../app/api/_lib/plain.js");
  for (const engine of ["dot", "neato", "fdp", "sfdp", "circo", "twopi"]) {
    const { nodes } = parsePlain(render(dotSource, { format: "plain", engine }));
    assert.equal(nodes.length, SAMPLE.nodes.length, `${engine} placed every node`);
    for (const n of nodes) {
      assert.ok(Number.isFinite(n.xInches) && Number.isFinite(n.yInches), `${engine} placed ${n.id}`);
    }
  }
});
