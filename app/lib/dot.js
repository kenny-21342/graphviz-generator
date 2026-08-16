/**
 * DOT source generation. Pure — no React, no DOM — so it can be unit tested
 * directly under `node --test`.
 */

import { PX_PER_INCH, isCircular, nodeBounds } from "./geometry.js";

/* ---------- escaping & quoting ---------- */

// Backslash escapes Graphviz understands inside a quoted string. A user who
// types `A\nB` in a label means "line break", so those sequences are passed
// through untouched; every other backslash is escaped to a literal one.
// The record separators are included so that escaping stays idempotent —
// `escapeRecordLabel` runs before `attrList` escapes the value again.
const GRAPHVIZ_ESCAPES = new Set([
  "n", "l", "r", "N", "G", "L", "E", "H", "T",
  "{", "}", "|", "<", ">",
]);

export function escapeString(value) {
  const str = String(value);
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\\") {
      const next = str[i + 1];
      if (next && GRAPHVIZ_ESCAPES.has(next)) {
        out += "\\" + next;
        i += 1;
      } else {
        out += "\\\\";
      }
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      // drop
    } else {
      out += ch;
    }
  }
  return out;
}

/** In record labels `{}|<>` are structural, so a literal must be escaped. */
export function escapeRecordLabel(value) {
  return escapeString(String(value).replace(/([{}|<>])/g, "\\$1"));
}

// DOT's unquoted-identifier grammar: [a-zA-Z\200-\377_][a-zA-Z\200-\377_0-9]*
const BARE_ID = /^[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*$/;
const NUMERIC_ID = /^-?(\.\d+|\d+(\.\d*)?)$/;
const RESERVED = new Set(["node", "edge", "graph", "digraph", "subgraph", "strict"]);

/** Emit an identifier bare when DOT allows it, quoted otherwise. */
export function quoteId(id) {
  const str = String(id);
  if (RESERVED.has(str.toLowerCase())) return `"${escapeString(str)}"`;
  if (BARE_ID.test(str) || NUMERIC_ID.test(str)) return str;
  return `"${escapeString(str)}"`;
}

/** Build ` [k="v", …]`, dropping empty values. Returns "" when nothing is set. */
export function attrList(pairs) {
  const items = pairs.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (items.length === 0) return "";
  const body = items.map(([k, v]) => `${k}="${escapeString(v)}"`).join(", ");
  return ` [${body}]`;
}

/* ---------- shape mapping ---------- */

// Internal shape kinds that are not Graphviz shape names.
const SHAPE_ALIASES = { rounded: "box" };

export const graphvizShape = (kind) => SHAPE_ALIASES[kind] || kind;

const RECORD_SHAPES = new Set(["record", "Mrecord"]);

/* ---------- attribute builders ---------- */

const DEFAULT_STROKE = "#0f172a";
const DEFAULT_EDGE_COLOR = "#475569";

/**
 * Node attributes. Emits exactly one `style=` and one `shape=`.
 *
 * `preservePositions` additionally pins the node to its canvas coordinates:
 * Graphviz's origin is bottom-left, so canvas Y is negated, and sizes are
 * converted from pixels to inches.
 */
export function buildNodeAttrs(node, { preservePositions = false } = {}) {
  const pairs = [];
  const label = node.label ?? node.id;
  pairs.push(["label", RECORD_SHAPES.has(node.shape) ? escapeRecordLabel(label) : label]);
  pairs.push(["shape", graphvizShape(node.shape)]);

  const styles = new Set();
  if (node.shape === "rounded") styles.add("rounded");
  if (node.style && node.style !== "solid") styles.add(node.style);
  if (node.fillColor && node.fillColor !== "transparent") {
    styles.add("filled");
    pairs.push(["fillcolor", node.fillColor]);
  }
  if (styles.size) pairs.push(["style", [...styles].join(",")]);

  if (node.strokeColor && node.strokeColor !== DEFAULT_STROKE) {
    pairs.push(["color", node.strokeColor]);
  }
  if (node.fontColor) pairs.push(["fontcolor", node.fontColor]);
  if (node.fontSize) pairs.push(["fontsize", node.fontSize]);
  if (node.lineWidth && node.lineWidth !== 1.5) pairs.push(["penwidth", node.lineWidth]);

  // The node's real on-canvas size always goes out, so an engine-computed
  // layout reserves the right amount of room instead of spacing Graphviz's
  // much smaller default boxes (which made auto-layout overlap).
  const b = nodeBounds(node);
  pairs.push(["width", round(b.w / PX_PER_INCH, 3)]);
  pairs.push(["height", round(b.h / PX_PER_INCH, 3)]);
  pairs.push(["fixedsize", "true"]);

  if (preservePositions) {
    pairs.push(["pos", `${round(b.cx)},${round(-b.cy)}!`]);
  }

  return pairs;
}

export function buildEdgeAttrs(edge) {
  const pairs = [];
  if (edge.label) pairs.push(["label", edge.label]);
  if (edge.style && edge.style !== "solid") pairs.push(["style", edge.style]);
  if (edge.color && edge.color !== DEFAULT_EDGE_COLOR) pairs.push(["color", edge.color]);
  if (edge.arrowhead && edge.arrowhead !== "normal") pairs.push(["arrowhead", edge.arrowhead]);
  if (edge.dir && edge.dir !== "forward") pairs.push(["dir", edge.dir]);
  if (edge.penwidth && edge.penwidth !== 1.5) pairs.push(["penwidth", edge.penwidth]);
  if (edge.fontColor) pairs.push(["fontcolor", edge.fontColor]);
  if (edge.fontSize) pairs.push(["fontsize", edge.fontSize]);
  return pairs;
}

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/* ---------- cluster helpers ---------- */

/**
 * Map every node to the cluster it actually belongs to. A `clusterId` that
 * points at a cluster which no longer exists is treated as unclustered, so the
 * node still reaches the output instead of silently vanishing.
 */
export function resolveClusterMembership(nodes, clusters) {
  const live = new Set(clusters.map((c) => c.id));
  const members = new Map(clusters.map((c) => [c.id, []]));
  const loose = [];
  for (const n of nodes) {
    if (n.clusterId && live.has(n.clusterId)) members.get(n.clusterId).push(n);
    else loose.push(n);
  }
  return { members, loose };
}

/** Subgraph names must begin with `cluster` for Graphviz to box them. */
export function clusterSubgraphName(id) {
  const str = String(id);
  return str.startsWith("cluster") ? str : `cluster_${str}`;
}

/* ---------- generator ---------- */

export function generateDot(state) {
  const { nodes = [], edges = [], clusters = [], graphAttrs = {} } = state;
  const preservePositions = graphAttrs.preservePositions !== false;
  const fontname = graphAttrs.fontname || "Helvetica";
  const lines = [];

  lines.push("// Generated by Graphviz Generator");
  lines.push(
    preservePositions
      ? "// Positions are pinned to the canvas — render with `-Kneato -n`"
      : `// Engine: ${graphAttrs.engine || "dot"}`
  );
  lines.push("digraph G {");

  const gPairs = [];
  // rankdir/nodesep/ranksep only mean something when an engine is free to
  // place nodes, so they are omitted while positions are pinned.
  if (!preservePositions) {
    if (graphAttrs.rankdir) gPairs.push(["rankdir", graphAttrs.rankdir]);
    if (Number.isFinite(graphAttrs.nodesep)) gPairs.push(["nodesep", graphAttrs.nodesep]);
    if (Number.isFinite(graphAttrs.ranksep)) gPairs.push(["ranksep", graphAttrs.ranksep]);
  }
  if (graphAttrs.splines && graphAttrs.splines !== "spline") {
    gPairs.push(["splines", graphAttrs.splines]);
  }
  if (graphAttrs.bgcolor && graphAttrs.bgcolor !== "#ffffff") {
    gPairs.push(["bgcolor", graphAttrs.bgcolor]);
  }
  gPairs.push(["fontname", fontname]);
  // Must be `graph [...]` — a bare attribute list is a DOT syntax error.
  if (gPairs.length) lines.push(`  graph${attrList(gPairs)};`);

  lines.push(
    `  node [fontname="${escapeString(fontname)}", fontsize="13", penwidth="1.5", color="${DEFAULT_STROKE}", style="solid"];`
  );
  lines.push(
    `  edge [fontname="${escapeString(fontname)}", fontsize="11", color="${DEFAULT_EDGE_COLOR}", penwidth="1.5"];`
  );

  const nodeLine = (n, indent) =>
    `${indent}${quoteId(n.id)}${attrList(buildNodeAttrs(n, { preservePositions }))};`;

  const { members, loose } = resolveClusterMembership(nodes, clusters);

  for (const cluster of clusters) {
    const kids = members.get(cluster.id) || [];
    if (kids.length === 0) continue; // an empty subgraph is not valid DOT worth emitting
    lines.push(`  subgraph ${quoteId(clusterSubgraphName(cluster.id))} {`);
    const cPairs = [];
    if (cluster.label) cPairs.push(["label", cluster.label]);
    if (cluster.color && cluster.color !== "#94a3b8") cPairs.push(["color", cluster.color]);
    cPairs.push(["style", "rounded,dashed"]);
    if (cluster.bgColor && cluster.bgColor !== "transparent") {
      cPairs.push(["bgcolor", cluster.bgColor]);
    }
    for (const [k, v] of cPairs) lines.push(`    ${k}="${escapeString(v)}";`);
    for (const n of kids) lines.push(nodeLine(n, "    "));
    lines.push("  }");
  }

  for (const n of loose) lines.push(nodeLine(n, "  "));

  for (const e of edges) {
    lines.push(`  ${quoteId(e.source)} -> ${quoteId(e.target)}${attrList(buildEdgeAttrs(e))};`);
  }

  lines.push("}");
  return lines.join("\n");
}
