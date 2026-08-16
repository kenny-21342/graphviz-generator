import test from "node:test";
import assert from "node:assert/strict";

import { parsePlain, toPixelLayout, tokenizePlainLine } from "../app/api/_lib/plain.js";

test("tokenizer keeps quoted fields together", () => {
  assert.deepEqual(tokenizePlainLine('node "my node" 1.5 2.5 0.75 0.5 "a b" solid box'), [
    "node",
    "my node",
    "1.5",
    "2.5",
    "0.75",
    "0.5",
    "a b",
    "solid",
    "box",
  ]);
});

test("tokenizer honours backslash escapes inside quotes", () => {
  assert.deepEqual(tokenizePlainLine('node "a\\"b" 1 2'), ["node", 'a"b', "1", "2"]);
});

test("a node name containing a space keeps its coordinates aligned", () => {
  const { nodes } = parsePlain(
    'graph 1 4 3\nnode "my node" 1.5 2.5 0.75 0.5 "my node" solid box black lightgrey\nstop\n'
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, "my node");
  assert.equal(nodes[0].xInches, 1.5);
  assert.equal(nodes[0].yInches, 2.5);
});

test("the graph scale factor is applied to coordinates", () => {
  const { nodes, graph } = parsePlain("graph 2 4 3\nnode a 1 2 0.5 0.5 a solid box black grey\n");
  assert.equal(graph.scale, 2);
  assert.equal(nodes[0].xInches, 2);
  assert.equal(nodes[0].yInches, 4);
  assert.equal(nodes[0].widthInches, 1);
});

test("a missing or zero scale falls back to 1", () => {
  assert.equal(parsePlain("graph 0 4 3\n").graph.scale, 1);
  assert.equal(parsePlain("node a 1 2 0.5 0.5 a solid box black grey\n").graph, null);
});

test("malformed lines are skipped rather than producing NaN nodes", () => {
  const { nodes } = parsePlain(
    "graph 1 4 3\nnode broken\nnode a 1 2 x y a solid box black grey\nstop\n"
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, "a");
  // Non-finite sizes fall back to 0 instead of poisoning the bounding box.
  assert.equal(nodes[0].widthInches, 0);
});

test("toPixelLayout flips Y and returns centres plus bounds", () => {
  const parsed = parsePlain(
    "graph 1 2 2\nnode a 0.5 1.5 1 1 a solid box black grey\nnode b 0.5 0.5 1 1 b solid box black grey\n"
  );
  const { layout, bounds } = toPixelLayout(parsed, { pxPerInch: 72, margin: 40 });

  const a = layout.find((n) => n.id === "a");
  const b = layout.find((n) => n.id === "b");
  // `a` sits above `b` in Graphviz space, so it must get the smaller pixel Y.
  assert.ok(a.y < b.y);
  // minX = 0, maxY = 2.0; coordinates are node centres.
  assert.equal(a.x, 0.5 * 72 + 40);
  assert.equal(a.y, (2.0 - 1.5) * 72 + 40);
  assert.equal(b.y, (2.0 - 0.5) * 72 + 40);
  assert.equal(a.width, 72);
  assert.equal(bounds.width, 1 * 72 + 80);
  assert.equal(bounds.height, 2 * 72 + 80);
});

test("an empty graph falls back to the reported graph dimensions", () => {
  const { layout, bounds } = toPixelLayout(parsePlain("graph 1 3 2\nstop\n"));
  assert.deepEqual(layout, []);
  assert.equal(bounds.width, 3 * 72 + 80);
  assert.equal(bounds.height, 2 * 72 + 80);
});
