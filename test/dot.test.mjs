import test from "node:test";
import assert from "node:assert/strict";

import {
  attrList,
  escapeRecordLabel,
  escapeString,
  generateDot,
  quoteId,
  resolveClusterMembership,
} from "../app/lib/dot.js";

const node = (over = {}) => ({
  id: "node_1",
  type: "node",
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

const build = (over = {}) =>
  generateDot({
    nodes: [],
    edges: [],
    clusters: [],
    graphAttrs: { preservePositions: false, engine: "dot", fontname: "Helvetica" },
    ...over,
  });

/* ---------- escaping ---------- */

test("escapeString keeps Graphviz escape sequences but escapes stray backslashes", () => {
  assert.equal(escapeString("A\\nB"), "A\\nB");
  assert.equal(escapeString("C:\\temp"), "C:\\\\temp");
  assert.equal(escapeString('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeString("a\r\nb"), "a\\nb");
});

test("record labels escape structural characters", () => {
  assert.equal(escapeRecordLabel("a|b"), "a\\|b");
  assert.equal(escapeRecordLabel("<x>"), "\\<x\\>");
});

test("quoteId quotes anything DOT cannot take bare", () => {
  assert.equal(quoteId("node_1"), "node_1");
  assert.equal(quoteId("42"), "42");
  assert.equal(quoteId("my node"), '"my node"');
  assert.equal(quoteId("graph"), '"graph"'); // reserved word
  assert.equal(quoteId("a-b"), '"a-b"');
});

test("attrList drops empty values and quotes the rest", () => {
  assert.equal(attrList([]), "");
  assert.equal(
    attrList([
      ["label", "hi"],
      ["color", ""],
      ["shape", null],
      ["fontsize", 13],
    ]),
    ' [label="hi", fontsize="13"]'
  );
});

/* ---------- node attributes ---------- */

test("a filled rounded node emits exactly one style= carrying both values", () => {
  const dot = build({ nodes: [node({ shape: "rounded", fillColor: "#dbeafe" })] });
  const line = dot.split("\n").find((l) => l.includes("node_1 ["));
  assert.ok(line, "node line present");

  const styles = line.match(/style="([^"]*)"/g);
  assert.equal(styles.length, 1, `expected one style=, got ${styles}`);
  assert.match(line, /style="rounded,filled"/);
  assert.match(line, /shape="box"/);
  assert.match(line, /fillcolor="#dbeafe"/);
});

test("dashed + filled combine, and a plain solid node emits no style=", () => {
  const dashed = build({ nodes: [node({ style: "dashed", fillColor: "#fff" })] });
  assert.match(dashed, /style="dashed,filled"/);

  const plain = build({ nodes: [node()] });
  const line = plain.split("\n").find((l) => l.includes("node_1 ["));
  assert.doesNotMatch(line, /style=/);
});

test("a label with \\n survives as a Graphviz line break", () => {
  const dot = build({ nodes: [node({ label: "first\\nsecond" })] });
  assert.match(dot, /label="first\\nsecond"/);
  assert.doesNotMatch(dot, /label="first\\\\nsecond"/);
});

test("record labels are escaped inside the generated DOT", () => {
  const dot = build({ nodes: [node({ shape: "record", label: "a|b" })] });
  assert.match(dot, /label="a\\\|b"/);
});

/* ---------- clusters ---------- */

test("a node whose clusterId dangles is still emitted", () => {
  const dot = build({ nodes: [node({ clusterId: "cluster_9" })], clusters: [] });
  assert.match(dot, /^\s*node_1 \[/m);
});

test("cluster membership splits live members from loose nodes", () => {
  const nodes = [
    node({ id: "a", clusterId: "cluster_1" }),
    node({ id: "b", clusterId: "cluster_gone" }),
    node({ id: "c" }),
  ];
  const { members, loose } = resolveClusterMembership(nodes, [{ id: "cluster_1" }]);
  assert.deepEqual(
    members.get("cluster_1").map((n) => n.id),
    ["a"]
  );
  assert.deepEqual(
    loose.map((n) => n.id),
    ["b", "c"]
  );
});

test("clusters keep their id as the subgraph name and empty ones are skipped", () => {
  const dot = build({
    nodes: [node({ id: "a", clusterId: "cluster_1" })],
    clusters: [
      { id: "cluster_1", label: "Group" },
      { id: "cluster_2", label: "Empty" },
    ],
  });
  assert.match(dot, /subgraph cluster_1 \{/);
  assert.doesNotMatch(dot, /cluster__1/); // the old double-underscore bug
  assert.doesNotMatch(dot, /cluster_2/);
});

/* ---------- positions ---------- */

test("preservePositions pins nodes with pos/width/height in Graphviz units", () => {
  const dot = build({
    nodes: [node({ x: 152, y: 88, width: 110, height: 50 })],
    graphAttrs: { preservePositions: true, fontname: "Helvetica" },
  });
  // Graphviz's origin is bottom-left, so canvas Y is negated.
  assert.match(dot, /pos="152,-88!"/);
  assert.match(dot, /width="1\.528"/);
  assert.match(dot, /height="0\.694"/);
  assert.match(dot, /fixedsize="true"/);
  // Layout attributes are meaningless when positions are pinned.
  assert.doesNotMatch(dot, /rankdir/);
});

test("circular nodes are sized from their radius", () => {
  const dot = build({
    nodes: [node({ shape: "circle", radius: 36, width: undefined, height: undefined })],
    graphAttrs: { preservePositions: true },
  });
  assert.match(dot, /width="1"/);
  assert.match(dot, /height="1"/);
});

test("without preservePositions the engine attributes come back", () => {
  const dot = build({
    nodes: [node()],
    graphAttrs: { preservePositions: false, rankdir: "LR", nodesep: 0.5, ranksep: 0.75 },
  });
  assert.match(dot, /rankdir="LR"/);
  assert.doesNotMatch(dot, /pos=/);
});

/* ---------- edges ---------- */

test("edges reference quoted ids and carry non-default attributes only", () => {
  const dot = build({
    nodes: [node({ id: "a" }), node({ id: "b b" })],
    edges: [
      { id: "e1", source: "a", target: "b b", dir: "none", style: "solid", arrowhead: "normal" },
    ],
  });
  assert.match(dot, /a -> "b b" \[dir="none"\]/);
});

test("the generated DOT is balanced", () => {
  const dot = build({
    nodes: [node({ id: "a", clusterId: "c1" })],
    clusters: [{ id: "c1", label: "G" }],
  });
  const opens = (dot.match(/\{/g) || []).length;
  const closes = (dot.match(/\}/g) || []).length;
  assert.equal(opens, closes);
});
