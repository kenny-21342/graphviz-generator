"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { generateDot } from "./lib/dot";
import {
  DEFAULT_NODE_H,
  DEFAULT_NODE_W,
  DEFAULT_RADIUS,
  boundsOfNodes,
  clipToNode,
  edgeContainsPoint,
  edgeEndpoints,
  isCircular,
  nodeBounds,
  nodeContainsPoint,
  nodeIntersectsRect,
  normalizeRect,
} from "./lib/geometry";

/* ============================================================
   Graphviz Generator — main editor
   ============================================================ */

/* ---------- constants & registry ---------- */

const PROJECT_DATA_VERSION = 1;
const GRID_SIZE = 20;
const HISTORY_LIMIT = 30;
const POINT_RADIUS = 6;
const AUTOSAVE_KEY = "gv-autosave";
const AUTOSAVE_INTERVAL_MS = 30000;

const NODE_SHAPES = [
  { kind: "box", label: "Box", cat: "Common" },
  { kind: "rounded", label: "Rounded", cat: "Common" },
  { kind: "ellipse", label: "Ellipse", cat: "Common" },
  { kind: "circle", label: "Circle", cat: "Common" },
  { kind: "diamond", label: "Diamond", cat: "Common" },
  { kind: "plaintext", label: "Plaintext", cat: "Common" },
  { kind: "triangle", label: "Triangle", cat: "Common" },
  { kind: "parallelogram", label: "Parallelogram", cat: "Polygons" },
  { kind: "hexagon", label: "Hexagon", cat: "Polygons" },
  { kind: "octagon", label: "Octagon", cat: "Polygons" },
  { kind: "doublecircle", label: "Double Circle", cat: "Polygons" },
  { kind: "point", label: "Point", cat: "Polygons" },
  { kind: "record", label: "Record", cat: "Records" },
  { kind: "Mrecord", label: "Mrecord", cat: "Records" },
  { kind: "Mdiamond", label: "Mdiamond", cat: "Records" },
  { kind: "Msquare", label: "Msquare", cat: "Records" },
];

const CATEGORIES = ["Common", "Polygons", "Records"];

const ENGINES = [
  { value: "dot", label: "dot — hierarchical" },
  { value: "neato", label: "neato — spring" },
  { value: "fdp", label: "fdp — force" },
  { value: "sfdp", label: "sfdp — large graph" },
  { value: "circo", label: "circo — circular" },
  { value: "twopi", label: "twopi — radial" },
];

const RANKDIRS = ["TB", "LR", "BT", "RL"];
const SPLINES = ["true", "curve", "line", "ortho", "polyline", "spline"];
const ARROWHEADS = [
  "normal",
  "vee",
  "empty",
  "odot",
  "diamond",
  "odiamond",
  "box",
  "obox",
  "crow",
  "inv",
  "none",
];
const EDGE_STYLES = ["solid", "dashed", "dotted", "bold", "tapered", "invis"];
const NODE_LINE_STYLES = ["solid", "dashed", "dotted", "bold"];
const DIRS = ["forward", "back", "both", "none"];

const PLACEHOLDER_TOOL = "__place__";

const DEFAULT_GRAPH_ATTRS = {
  engine: "dot",
  rankdir: "TB",
  splines: "spline",
  bgcolor: "#ffffff",
  fontname: "Helvetica",
  nodesep: 0.5,
  ranksep: 0.75,
  preservePositions: true,
};

/* ---------- utility ---------- */

const cx = (...xs) => xs.filter(Boolean).join(" ");

const toFinite = (v, fallback = 0) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

const now = () => Date.now();

const sanitize = (obj) => {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object" && (v.$$typeof || v.nodeType)) continue;
    if (typeof v === "function") continue;
    out[k] = sanitize(v);
  }
  return out;
};

const newId = (prefix, counter) => {
  counter.current += 1;
  return `${prefix}_${counter.current}`;
};

/** Highest numeric suffix across ids, without spreading a huge array. */
const maxIdSuffix = (items) =>
  items.reduce((max, item) => {
    const n = parseInt(String(item?.id ?? "").replace(/\D/g, ""), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

/** Trigger a download without the blob URL being revoked out from under it. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Revoking synchronously cancels the download in some browsers.
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

const safeFilename = (name, fallback = "graph") =>
  (name || fallback).replace(/[^a-z0-9_-]+/gi, "_") || fallback;

/* ---------- default element factories ---------- */

function makeNode(id, shape, x, y) {
  const base = {
    id,
    type: "node",
    shape,
    label: id.replace(/^node_/, "N"),
    x,
    y,
    strokeColor: "#0f172a",
    fillColor: "transparent",
    fontColor: "#0f172a",
    fontSize: 13,
    lineWidth: 1.5,
    style: "solid",
    clusterId: null,
    created: now(),
    modified: now(),
  };
  return { ...base, ...defaultSizeFor(shape) };
}

/** The size fields a shape needs — circular shapes use a radius. */
function defaultSizeFor(shape) {
  if (shape === "point") return { radius: POINT_RADIUS };
  if (isCircular(shape)) return { radius: DEFAULT_RADIUS };
  return { width: DEFAULT_NODE_W, height: DEFAULT_NODE_H };
}

function makeEdge(id, source, target) {
  return {
    id,
    type: "edge",
    source,
    target,
    label: "",
    color: "#475569",
    style: "solid",
    arrowhead: "normal",
    dir: "forward",
    penwidth: 1.5,
    fontColor: "#0f172a",
    fontSize: 11,
    created: now(),
    modified: now(),
  };
}

function makeCluster(id) {
  return {
    id,
    type: "cluster",
    label: "Cluster",
    color: "#94a3b8",
    bgColor: "transparent",
    created: now(),
    modified: now(),
  };
}

/* ---------- project save/load ---------- */

function normalizeLoadedElement(el) {
  if (!el || typeof el !== "object") return null;
  const t = el.type;
  if (t === "node") {
    const shape = String(el.shape || "box");
    const size = defaultSizeFor(shape);
    return {
      id: String(el.id),
      type: "node",
      shape,
      label: el.label != null ? String(el.label) : String(el.id),
      x: toFinite(el.x),
      y: toFinite(el.y),
      // Keep only the size fields this shape actually uses, so a shape swap
      // can never leave a node with neither radius nor width/height.
      ...(size.radius !== undefined
        ? { radius: toFinite(el.radius, size.radius) }
        : {
            width: toFinite(el.width, DEFAULT_NODE_W),
            height: toFinite(el.height, DEFAULT_NODE_H),
          }),
      strokeColor: el.strokeColor || "#0f172a",
      fillColor: el.fillColor || "transparent",
      fontColor: el.fontColor || "#0f172a",
      fontSize: toFinite(el.fontSize, 13),
      lineWidth: toFinite(el.lineWidth, 1.5),
      style: el.style || "solid",
      clusterId: el.clusterId ? String(el.clusterId) : null,
      created: toFinite(el.created, now()),
      modified: toFinite(el.modified, now()),
    };
  }
  if (t === "edge") {
    return {
      id: String(el.id),
      type: "edge",
      source: String(el.source),
      target: String(el.target),
      label: el.label ? String(el.label) : "",
      color: el.color || "#475569",
      style: el.style || "solid",
      arrowhead: el.arrowhead || "normal",
      dir: el.dir || "forward",
      penwidth: toFinite(el.penwidth, 1.5),
      fontColor: el.fontColor || "#0f172a",
      fontSize: toFinite(el.fontSize, 11),
      created: toFinite(el.created, now()),
      modified: toFinite(el.modified, now()),
    };
  }
  if (t === "cluster") {
    return {
      id: String(el.id),
      type: "cluster",
      label: el.label != null ? String(el.label) : "Cluster",
      color: el.color || "#94a3b8",
      bgColor: el.bgColor || "transparent",
      created: toFinite(el.created, now()),
      modified: toFinite(el.modified, now()),
    };
  }
  return null;
}

function normalizeProjectData(data) {
  if (!data || typeof data !== "object") return null;
  const nodes = Array.isArray(data.nodes)
    ? data.nodes.map(normalizeLoadedElement).filter(Boolean)
    : [];
  const edges = Array.isArray(data.edges)
    ? data.edges.map(normalizeLoadedElement).filter(Boolean)
    : [];
  const clusters = Array.isArray(data.clusters)
    ? data.clusters.map(normalizeLoadedElement).filter(Boolean)
    : [];

  // Drop references that no longer resolve, so they cannot corrupt the output.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const clusterIds = new Set(clusters.map((c) => c.id));
  for (const n of nodes) {
    if (n.clusterId && !clusterIds.has(n.clusterId)) n.clusterId = null;
  }
  const liveEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  const attrs = data.graphAttrs || {};
  return {
    version: PROJECT_DATA_VERSION,
    name: data.name || "Untitled",
    created: toFinite(data.created, now()),
    modified: toFinite(data.modified, now()),
    nodes,
    edges: liveEdges,
    clusters,
    graphAttrs: {
      engine: attrs.engine || DEFAULT_GRAPH_ATTRS.engine,
      rankdir: attrs.rankdir || DEFAULT_GRAPH_ATTRS.rankdir,
      splines: attrs.splines || DEFAULT_GRAPH_ATTRS.splines,
      bgcolor: attrs.bgcolor || DEFAULT_GRAPH_ATTRS.bgcolor,
      fontname: attrs.fontname || DEFAULT_GRAPH_ATTRS.fontname,
      nodesep: toFinite(attrs.nodesep, DEFAULT_GRAPH_ATTRS.nodesep),
      ranksep: toFinite(attrs.ranksep, DEFAULT_GRAPH_ATTRS.ranksep),
      preservePositions: attrs.preservePositions !== false,
    },
    viewport: data.viewport || null,
  };
}

function parseProjectJson(text) {
  try {
    return normalizeProjectData(JSON.parse(text));
  } catch {
    return null;
  }
}

function buildProjectSnapshot(state) {
  return {
    version: PROJECT_DATA_VERSION,
    name: state.projectName,
    created: state.createdTs,
    modified: now(),
    nodes: state.nodes.map(sanitize),
    edges: state.edges.map(sanitize),
    clusters: state.clusters.map(sanitize),
    graphAttrs: { ...state.graphAttrs },
    viewport: {
      zoom: state.zoom,
      pan: { ...state.pan },
      showGrid: state.showGrid,
    },
  };
}

/* ---------- history helpers ---------- */

const snapshotOf = (doc) => ({
  nodes: doc.nodes.map((n) => ({ ...n })),
  edges: doc.edges.map((e) => ({ ...e })),
  clusters: doc.clusters.map((c) => ({ ...c })),
  graphAttrs: { ...doc.graphAttrs },
});

const sameDoc = (a, b) =>
  a.nodes.length === b.nodes.length &&
  a.edges.length === b.edges.length &&
  a.clusters.length === b.clusters.length &&
  JSON.stringify(a.nodes) === JSON.stringify(b.nodes) &&
  JSON.stringify(a.edges) === JSON.stringify(b.edges) &&
  JSON.stringify(a.clusters) === JSON.stringify(b.clusters) &&
  JSON.stringify(a.graphAttrs) === JSON.stringify(b.graphAttrs);

/* ---------- canvas drawing primitives ---------- */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function polygonPath(ctx, cxp, cyp, rx, ry, sides, rotation = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = (Math.PI * 2 * i) / sides + rotation;
    const px = cxp + rx * Math.cos(a);
    const py = cyp + ry * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Trace a node's outline. One case per palette entry — the previous
 * if/else chain made `point`, `Mrecord`, `Mdiamond` and `parallelogram`
 * unreachable, so they all drew as something else.
 */
function traceNodeShape(ctx, node, b) {
  switch (node.shape) {
    case "circle":
    case "doublecircle":
    case "point":
      ctx.beginPath();
      ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2);
      return;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(b.cx, b.cy, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      return;
    case "diamond":
    case "Mdiamond":
      ctx.beginPath();
      ctx.moveTo(b.cx, b.y);
      ctx.lineTo(b.x + b.w, b.cy);
      ctx.lineTo(b.cx, b.y + b.h);
      ctx.lineTo(b.x, b.cy);
      ctx.closePath();
      return;
    case "triangle":
      ctx.beginPath();
      ctx.moveTo(b.cx, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h);
      ctx.lineTo(b.x, b.y + b.h);
      ctx.closePath();
      return;
    case "parallelogram": {
      const skew = Math.min(b.w * 0.2, 24);
      ctx.beginPath();
      ctx.moveTo(b.x + skew, b.y);
      ctx.lineTo(b.x + b.w, b.y);
      ctx.lineTo(b.x + b.w - skew, b.y + b.h);
      ctx.lineTo(b.x, b.y + b.h);
      ctx.closePath();
      return;
    }
    case "hexagon":
      polygonPath(ctx, b.cx, b.cy, b.w / 2, b.h / 2, 6, 0);
      return;
    case "octagon":
      polygonPath(ctx, b.cx, b.cy, b.w / 2, b.h / 2, 8, Math.PI / 8);
      return;
    case "rounded":
    case "Mrecord":
      roundRect(ctx, b.x, b.y, b.w, b.h, 10);
      return;
    case "plaintext":
      ctx.beginPath();
      return;
    default:
      // box, record, Msquare and anything unknown
      roundRect(ctx, b.x, b.y, b.w, b.h, 0);
  }
}

function drawNode(ctx, node, opts = {}) {
  const { selected, hovered, fontname } = opts;
  const b = nodeBounds(node);
  const fill = node.fillColor && node.fillColor !== "transparent" ? node.fillColor : null;

  ctx.save();
  ctx.lineWidth = node.lineWidth || 1.5;
  ctx.strokeStyle = node.strokeColor || "#0f172a";
  if (node.style === "dashed") ctx.setLineDash([6, 4]);
  else if (node.style === "dotted") ctx.setLineDash([2, 4]);
  else ctx.setLineDash([]);
  if (node.style === "bold") ctx.lineWidth = (node.lineWidth || 1.5) * 2;

  if (node.shape === "point") {
    // A Graphviz `point` is a small filled dot, not a full-size circle.
    ctx.beginPath();
    ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2);
    ctx.fillStyle = fill || node.strokeColor || "#0f172a";
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    drawSelectionRing(ctx, b, { selected, hovered });
    return;
  }

  if (node.shape !== "plaintext") {
    traceNodeShape(ctx, node, b);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.stroke();

    if (node.shape === "doublecircle") {
      ctx.beginPath();
      ctx.arc(b.cx, b.cy, Math.max(2, b.r - 5), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (node.shape === "record" || node.shape === "Mrecord") {
      ctx.beginPath();
      ctx.moveTo(b.x, b.cy);
      ctx.lineTo(b.x + b.w, b.cy);
      ctx.stroke();
    }
    if (node.shape === "Msquare" || node.shape === "Mdiamond") {
      // The "M" shapes carry diagonal corner ticks.
      const t = Math.min(b.w, b.h) * 0.18;
      ctx.beginPath();
      ctx.moveTo(b.x + t, b.y);
      ctx.lineTo(b.x, b.y + t);
      ctx.moveTo(b.x + b.w - t, b.y);
      ctx.lineTo(b.x + b.w, b.y + t);
      ctx.moveTo(b.x + t, b.y + b.h);
      ctx.lineTo(b.x, b.y + b.h - t);
      ctx.moveTo(b.x + b.w - t, b.y + b.h);
      ctx.lineTo(b.x + b.w, b.y + b.h - t);
      ctx.stroke();
    }
  }

  ctx.setLineDash([]);

  // Label — `\n` is a line break, matching how Graphviz reads the DOT.
  ctx.fillStyle = node.fontColor || "#0f172a";
  ctx.font = `${node.fontSize || 13}px ${fontname || "Helvetica"}, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = String(node.label ?? node.id).split("\\n");
  const lh = (node.fontSize || 13) * 1.2;
  const startY = b.cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, b.cx, startY + i * lh));

  ctx.restore();
  drawSelectionRing(ctx, b, { selected, hovered });
}

function drawSelectionRing(ctx, b, { selected, hovered }) {
  if (!selected && !hovered) return;
  ctx.save();
  ctx.strokeStyle = selected ? "#4f46e5" : "#c7d2fe";
  ctx.lineWidth = 1.5;
  if (selected) ctx.setLineDash([4, 3]);
  const pad = 5;
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.restore();
}

function drawEdge(ctx, edge, nodes, opts = {}) {
  const { selected, hovered, fontname, bgcolor } = opts;
  const ends = edgeEndpoints(edge, nodes);
  if (!ends) return;
  const { start, end } = ends;

  ctx.save();
  ctx.strokeStyle = edge.color || "#475569";
  ctx.lineWidth = edge.penwidth || 1.5;
  if (edge.style === "dashed") ctx.setLineDash([7, 4]);
  else if (edge.style === "dotted") ctx.setLineDash([2, 4]);
  else ctx.setLineDash([]);
  if (edge.style === "bold") ctx.lineWidth = (edge.penwidth || 1.5) * 2;
  if (edge.style === "invis") {
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const ang = Math.atan2(end.y - start.y, end.x - start.x);
  if (edge.dir !== "none") {
    const heads = [];
    if (edge.dir === "forward" || edge.dir === "both") heads.push(["head", end, ang]);
    if (edge.dir === "back" || edge.dir === "both") heads.push(["tail", start, ang + Math.PI]);
    for (const [, point, angle] of heads) {
      ctx.save();
      ctx.fillStyle = edge.color || "#475569";
      ctx.strokeStyle = edge.color || "#475569";
      drawArrowhead(ctx, point.x, point.y, angle, edge.arrowhead || "normal", 9);
      ctx.restore();
    }
  }

  if (edge.label) {
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    ctx.save();
    ctx.font = `${edge.fontSize || 11}px ${fontname || "Helvetica"}, sans-serif`;
    const text = String(edge.label);
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = bgcolor || "#ffffff";
    ctx.fillRect(mx - tw / 2 - 4, my - 8, tw + 8, 16);
    ctx.fillStyle = edge.fontColor || "#0f172a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, mx, my);
    ctx.restore();
  }

  if (selected || hovered) {
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    ctx.save();
    ctx.fillStyle = selected ? "#4f46e5" : "#c7d2fe";
    ctx.beginPath();
    ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

function drawArrowhead(ctx, x, y, angle, type, size) {
  const s = size;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const tip = { x, y };
  const base = { x: x - cos * s, y: y - sin * s };
  const left = { x: base.x + sin * s * 0.55, y: base.y - cos * s * 0.55 };
  const right = { x: base.x - sin * s * 0.55, y: base.y + cos * s * 0.55 };

  switch (type) {
    case "none":
      return;
    case "vee":
    case "crow":
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(left.x, left.y);
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
      return;
    case "inv":
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(tip.x + sin * s * 0.55, tip.y - cos * s * 0.55);
      ctx.lineTo(tip.x - sin * s * 0.55, tip.y + cos * s * 0.55);
      ctx.closePath();
      ctx.fill();
      return;
    case "empty":
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.closePath();
      ctx.stroke();
      return;
    case "odot":
      ctx.beginPath();
      ctx.arc(base.x, base.y, s * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      return;
    case "diamond":
    case "odiamond": {
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(left.x, left.y);
      ctx.lineTo(base.x - cos * s, base.y - sin * s);
      ctx.lineTo(right.x, right.y);
      ctx.closePath();
      if (type === "odiamond") ctx.stroke();
      else ctx.fill();
      return;
    }
    case "box":
    case "obox":
      ctx.save();
      ctx.translate(tip.x, tip.y);
      ctx.rotate(angle);
      if (type === "obox") ctx.strokeRect(-s, -s * 0.4, s, s * 0.8);
      else ctx.fillRect(-s, -s * 0.4, s, s * 0.8);
      ctx.restore();
      return;
    default:
      // normal
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.closePath();
      ctx.fill();
  }
}

function drawCluster(ctx, cluster, members, selected) {
  const box = boundsOfNodes(members);
  if (!box) return;
  const pad = 18;
  const x = box.x - pad;
  const y = box.y - pad;
  const w = box.w + pad * 2;
  const h = box.h + pad * 2;

  ctx.save();
  if (cluster.bgColor && cluster.bgColor !== "transparent") {
    ctx.fillStyle = cluster.bgColor;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = selected ? "#4f46e5" : cluster.color || "#94a3b8";
  ctx.lineWidth = selected ? 2 : 1.4;
  ctx.setLineDash([6, 4]);
  roundRect(ctx, x, y, w, h, 10);
  ctx.stroke();
  ctx.setLineDash([]);

  if (cluster.label) {
    ctx.fillStyle = selected ? "#4f46e5" : cluster.color || "#94a3b8";
    ctx.font = "600 12px Helvetica, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(cluster.label), x + 8, y + 14);
  }
  ctx.restore();
}

/* ============================================================
   Main component
   ============================================================ */

export default function GraphvizApp() {
  /* ----- element state ----- */
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [graphAttrs, setGraphAttrs] = useState(DEFAULT_GRAPH_ATTRS);

  const nodeCounter = useRef(0);
  const edgeCounter = useRef(0);
  const clusterCounter = useRef(0);

  /**
   * Authoritative mirror of the document. Every mutation writes here first,
   * so code that changes state twice in one event (or resumes after an
   * `await`) always sees the current values instead of a stale render
   * closure. React state follows for rendering.
   */
  const docRef = useRef({ nodes, edges, clusters, graphAttrs });

  const [history, setHistory] = useState({
    stack: [{ nodes: [], edges: [], clusters: [], graphAttrs: DEFAULT_GRAPH_ATTRS }],
    index: 0,
  });
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  /* ----- selection / interaction ----- */
  const [tool, setTool] = useState("select");
  const [pendingShape, setPendingShape] = useState(null);
  // A single selection model: many nodes, or exactly one edge/cluster.
  const [selection, setSelection] = useState({ type: null, ids: [] });
  const selectionRef = useRef(selection);
  const [hovered, setHovered] = useState({ type: null, id: null });

  /** Selection always goes through here so handlers can read it back at once. */
  const selectSet = useCallback((next) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectFrom, setConnectFrom] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [marquee, setMarquee] = useState(null);

  /* ----- viewport ----- */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showGrid, setShowGrid] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const spaceHeld = useRef(false);
  // Mirrors the viewport for pointer/wheel handlers, which must not be
  // re-bound on every zoom or pan step.
  const viewRef = useRef({ zoom, pan });
  useEffect(() => {
    viewRef.current = { zoom, pan };
  }, [zoom, pan]);

  /* ----- project ----- */
  const [projectName, setProjectName] = useState("Untitled");
  const [createdTs] = useState(now);

  /* ----- output dock ----- */
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputTab, setOutputTab] = useState("code");
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(null); // { src, format }
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderError, setRenderError] = useState(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [recoverable, setRecoverable] = useState(null);
  const [dockHeight, setDockHeight] = useState(260);

  /* ----- panels ----- */
  const [railWidth, setRailWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(290);
  const [activeCat, setActiveCat] = useState("Common");
  const [shapeSearch, setShapeSearch] = useState("");

  /* ----- refs ----- */
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const resizingDock = useRef(false);
  const resizingRail = useRef(false);
  const resizingRight = useRef(false);
  const timersRef = useRef(new Set());

  /* ----- timers that clean themselves up on unmount ----- */
  const later = useCallback((fn, ms) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);

  const showToast = useCallback(
    (message, kind = "error") => {
      setToast({ message, kind });
      later(() => setToast(null), 4000);
    },
    [later]
  );

  /* ----- history ----- */
  const pushHistory = useCallback((doc) => {
    setHistory((h) => {
      const top = h.stack[h.index];
      // An onBlur commit with no actual edit must not add a history step.
      if (top && sameDoc(top, doc)) return h;
      const truncated = h.stack.slice(0, h.index + 1);
      truncated.push(snapshotOf(doc));
      while (truncated.length > HISTORY_LIMIT) truncated.shift();
      return { stack: truncated, index: truncated.length - 1 };
    });
  }, []);

  /**
   * The single entry point for changing the document. `patch` holds whichever
   * of nodes/edges/clusters/graphAttrs changed; `commit` pushes a history step.
   */
  const applyDoc = useCallback(
    (patch, { commit = false } = {}) => {
      const next = { ...docRef.current, ...patch };
      docRef.current = next;
      if (patch.nodes) setNodes(patch.nodes);
      if (patch.edges) setEdges(patch.edges);
      if (patch.clusters) setClusters(patch.clusters);
      if (patch.graphAttrs) setGraphAttrs(patch.graphAttrs);
      if (commit) pushHistory(next);
      return next;
    },
    [pushHistory]
  );

  const commitHistory = useCallback(() => {
    pushHistory(docRef.current);
  }, [pushHistory]);

  const restoreEntry = useCallback((entry) => {
    const doc = snapshotOf(entry);
    docRef.current = doc;
    setNodes(doc.nodes);
    setEdges(doc.edges);
    setClusters(doc.clusters);
    setGraphAttrs(doc.graphAttrs);
    selectSet({ type: null, ids: [] });
    setHovered({ type: null, id: null });
  }, [selectSet]);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    const idx = h.index - 1;
    restoreEntry(h.stack[idx]);
    setHistory((cur) => ({ ...cur, index: idx }));
  }, [restoreEntry]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    const idx = h.index + 1;
    restoreEntry(h.stack[idx]);
    setHistory((cur) => ({ ...cur, index: idx }));
  }, [restoreEntry]);

  /* ----- derived ----- */
  const selectedIds = useMemo(() => new Set(selection.ids), [selection.ids]);

  const selectedElement = useMemo(() => {
    if (selection.ids.length !== 1) return null;
    const id = selection.ids[0];
    if (selection.type === "node") return nodes.find((n) => n.id === id) || null;
    if (selection.type === "edge") return edges.find((e) => e.id === id) || null;
    if (selection.type === "cluster") return clusters.find((c) => c.id === id) || null;
    return null;
  }, [selection, nodes, edges, clusters]);

  const selectedNodes = useMemo(
    () => (selection.type === "node" ? nodes.filter((n) => selectedIds.has(n.id)) : []),
    [selection.type, selectedIds, nodes]
  );

  const filteredShapes = useMemo(() => {
    const list = activeCat === "All" ? NODE_SHAPES : NODE_SHAPES.filter((s) => s.cat === activeCat);
    if (!shapeSearch.trim()) return list;
    const q = shapeSearch.toLowerCase();
    return list.filter((s) => s.label.toLowerCase().includes(q) || s.kind.toLowerCase().includes(q));
  }, [activeCat, shapeSearch]);

  const dotCode = useMemo(
    () => generateDot({ nodes, edges, clusters, graphAttrs }),
    [nodes, edges, clusters, graphAttrs]
  );

  /* ----- coordinate transforms ----- */
  const snap = useCallback(
    (v) => (snapToGrid ? Math.round(v / GRID_SIZE) * GRID_SIZE : v),
    [snapToGrid]
  );

  /**
   * Screen -> canvas. Deliberately unsnapped: snapping here also quantised
   * hit-testing and hover, which made thin edges unselectable.
   */
  const screenToCanvas = useCallback((clientX, clientY) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const { zoom: z, pan: p } = viewRef.current;
    return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z };
  }, []);

  /* ----- element ops ----- */
  const addNode = useCallback(
    (shape, x, y) => {
      const id = newId("node", nodeCounter);
      const node = makeNode(id, shape, snap(x), snap(y));
      applyDoc({ nodes: [...docRef.current.nodes, node] }, { commit: true });
      selectSet({ type: "node", ids: [id] });
      return node;
    },
    [applyDoc, snap, selectSet]
  );

  const addEdge = useCallback(
    (sourceId, targetId) => {
      if (sourceId === targetId) return null;
      const { edges: cur } = docRef.current;
      if (cur.some((e) => e.source === sourceId && e.target === targetId)) return null;
      const id = newId("edge", edgeCounter);
      const edge = makeEdge(id, sourceId, targetId);
      applyDoc({ edges: [...cur, edge] }, { commit: true });
      selectSet({ type: "edge", ids: [id] });
      return edge;
    },
    [applyDoc, selectSet]
  );

  /** Patch the current selection. Reads the live doc, so repeated calls stack. */
  const updateSelected = useCallback(
    (key, value, { commit = false } = {}) => {
      const { type, ids } = selectionRef.current;
      if (!type || ids.length === 0) return;
      const idSet = new Set(ids);
      const patchOne = (el) => (idSet.has(el.id) ? { ...el, [key]: value, modified: now() } : el);
      const doc = docRef.current;
      if (type === "node") applyDoc({ nodes: doc.nodes.map(patchOne) }, { commit });
      else if (type === "edge") applyDoc({ edges: doc.edges.map(patchOne) }, { commit });
      else if (type === "cluster") applyDoc({ clusters: doc.clusters.map(patchOne) }, { commit });
    },
    [applyDoc]
  );

  /** Delete explicit targets — never the previous selection. */
  const deleteElements = useCallback(
    (type, ids) => {
      if (!type || ids.length === 0) return;
      const idSet = new Set(ids);
      const doc = docRef.current;
      if (type === "node") {
        applyDoc(
          {
            nodes: doc.nodes.filter((n) => !idSet.has(n.id)),
            edges: doc.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
          },
          { commit: true }
        );
      } else if (type === "edge") {
        applyDoc({ edges: doc.edges.filter((e) => !idSet.has(e.id)) }, { commit: true });
      } else if (type === "cluster") {
        applyDoc(
          {
            // Dissolving a cluster releases its nodes rather than deleting them.
            nodes: doc.nodes.map((n) => (idSet.has(n.clusterId) ? { ...n, clusterId: null } : n)),
            clusters: doc.clusters.filter((c) => !idSet.has(c.id)),
          },
          { commit: true }
        );
      }
      if (selectionRef.current.type === type) selectSet({ type: null, ids: [] });
    },
    [applyDoc, selectSet]
  );

  const deleteSelection = useCallback(() => {
    const { type, ids } = selectionRef.current;
    deleteElements(type, ids);
  }, [deleteElements]);

  const duplicateSelection = useCallback(() => {
    const selected = selectionRef.current;
    if (selected.type !== "node" || selected.ids.length === 0) return;
    const doc = docRef.current;
    const idSet = new Set(selected.ids);
    const copies = doc.nodes
      .filter((n) => idSet.has(n.id))
      .map((orig) => ({
        ...orig,
        id: newId("node", nodeCounter),
        x: orig.x + 24,
        y: orig.y + 24,
        clusterId: null,
        created: now(),
        modified: now(),
      }));
    if (copies.length === 0) return;
    applyDoc({ nodes: [...doc.nodes, ...copies] }, { commit: true });
    selectSet({ type: "node", ids: copies.map((c) => c.id) });
  }, [applyDoc, selectSet]);

  /** Group exactly the selected nodes, leaving other clusters untouched. */
  const groupSelectionIntoCluster = useCallback(() => {
    const selected = selectionRef.current;
    if (selected.type !== "node" || selected.ids.length < 2) return;
    const id = newId("cluster", clusterCounter);
    const idSet = new Set(selected.ids);
    const doc = docRef.current;
    applyDoc(
      {
        nodes: doc.nodes.map((n) => (idSet.has(n.id) ? { ...n, clusterId: id } : n)),
        clusters: [...doc.clusters, makeCluster(id)],
      },
      { commit: true }
    );
    selectSet({ type: "cluster", ids: [id] });
  }, [applyDoc, selectSet]);

  const clearAll = useCallback(() => {
    applyDoc({ nodes: [], edges: [], clusters: [] }, { commit: true });
    selectSet({ type: null, ids: [] });
  }, [applyDoc, selectSet]);

  /* ----- hit testing ----- */
  const nodeAt = useCallback((x, y) => {
    const { nodes: cur } = docRef.current;
    for (let i = cur.length - 1; i >= 0; i--) {
      if (nodeContainsPoint(cur[i], x, y)) return cur[i];
    }
    return null;
  }, []);

  const edgeAt = useCallback((x, y) => {
    const { edges: cur, nodes: curNodes } = docRef.current;
    for (let i = cur.length - 1; i >= 0; i--) {
      if (edgeContainsPoint(cur[i], curNodes, x, y)) return cur[i];
    }
    return null;
  }, []);

  /* ----- pointer handlers ----- */
  const beginPan = (e) => {
    setIsPanning(true);
    const { pan: p } = viewRef.current;
    panStart.current = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
  };

  const onPointerDown = (e) => {
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    canvasRef.current?.setPointerCapture(e.pointerId);
    setMousePos({ x, y });

    if (e.button === 1 || spaceHeld.current || tool === "pan") {
      beginPan(e);
      return;
    }
    if (e.button !== 0) return;

    const additive = e.shiftKey || e.metaKey || e.ctrlKey;

    if (tool === PLACEHOLDER_TOOL && pendingShape) {
      addNode(pendingShape, x, y);
      setTool("select");
      setPendingShape(null);
      return;
    }

    if (tool === "delete") {
      const hitNode = nodeAt(x, y);
      if (hitNode) {
        deleteElements("node", [hitNode.id]);
        return;
      }
      const hitEdge = edgeAt(x, y);
      if (hitEdge) deleteElements("edge", [hitEdge.id]);
      return;
    }

    if (tool === "edge") {
      const hitNode = nodeAt(x, y);
      if (hitNode) {
        setIsConnecting(true);
        setConnectFrom(hitNode.id);
        selectSet({ type: "node", ids: [hitNode.id] });
      }
      return;
    }

    // select tool
    const hitNode = nodeAt(x, y);
    if (hitNode) {
      const cur = selectionRef.current;
      const already = cur.type === "node" && cur.ids.includes(hitNode.id);
      let ids;
      if (additive && cur.type === "node") {
        // Shift/Cmd-click toggles this node in or out of the selection.
        ids = already ? cur.ids.filter((i) => i !== hitNode.id) : [...cur.ids, hitNode.id];
      } else {
        // Clicking a node that is already selected keeps the group intact so
        // the whole selection can be dragged together.
        ids = already ? cur.ids : [hitNode.id];
      }
      selectSet({ type: "node", ids });

      // Drag the whole selection, from its positions at drag start.
      const dragIds = new Set(ids.includes(hitNode.id) ? ids : [hitNode.id]);
      const origins = new Map();
      for (const n of docRef.current.nodes) {
        if (dragIds.has(n.id)) origins.set(n.id, { x: n.x, y: n.y });
      }
      dragRef.current = { start: { x, y }, origins, moved: false };
      setIsDragging(true);
      return;
    }

    const hitEdge = edgeAt(x, y);
    if (hitEdge) {
      selectSet({ type: "edge", ids: [hitEdge.id] });
      return;
    }

    const hitCluster = clusterAt(docRef.current, x, y);
    if (hitCluster) {
      selectSet({ type: "cluster", ids: [hitCluster.id] });
      return;
    }

    // Empty canvas: rubber-band select (panning is space/middle/pan-tool).
    if (!additive) selectSet({ type: null, ids: [] });
    setMarquee({ x1: x, y1: y, x2: x, y2: y, additive });
  };

  const onPointerMove = (e) => {
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    setMousePos({ x, y });

    if (isPanning) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setPan({ x: panStart.current.px + dx, y: panStart.current.py + dy });
      return;
    }

    if (marquee) {
      setMarquee((m) => (m ? { ...m, x2: x, y2: y } : m));
      return;
    }

    if (isConnecting) {
      const tgt = nodeAt(x, y);
      setHovered(tgt && tgt.id !== connectFrom ? { type: "node", id: tgt.id } : { type: null, id: null });
      return;
    }

    if (isDragging && dragRef.current) {
      const { start, origins } = dragRef.current;
      const dx = x - start.x;
      const dy = y - start.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) dragRef.current.moved = true;
      const nextNodes = docRef.current.nodes.map((n) => {
        const origin = origins.get(n.id);
        if (!origin) return n;
        return { ...n, x: snap(origin.x + dx), y: snap(origin.y + dy) };
      });
      applyDoc({ nodes: nextNodes });
      return;
    }

    if (tool === "select") {
      const hn = nodeAt(x, y);
      if (hn) {
        setHovered({ type: "node", id: hn.id });
        return;
      }
      const he = edgeAt(x, y);
      setHovered(he ? { type: "edge", id: he.id } : { type: null, id: null });
    }
  };

  const onPointerUp = (e) => {
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {}
    const { x, y } = screenToCanvas(e.clientX, e.clientY);

    if (isPanning) {
      setIsPanning(false);
      return;
    }

    if (marquee) {
      const rect = normalizeRect(marquee.x1, marquee.y1, x, y);
      const hits = docRef.current.nodes.filter((n) => nodeIntersectsRect(n, rect)).map((n) => n.id);
      if (rect.w > 3 || rect.h > 3) {
        const cur = selectionRef.current;
        if (marquee.additive && cur.type === "node") {
          selectSet({ type: "node", ids: [...new Set([...cur.ids, ...hits])] });
        } else {
          selectSet(hits.length ? { type: "node", ids: hits } : { type: null, ids: [] });
        }
      }
      setMarquee(null);
      return;
    }

    if (isConnecting) {
      const tgt = nodeAt(x, y);
      if (tgt && tgt.id !== connectFrom) addEdge(connectFrom, tgt.id);
      setIsConnecting(false);
      setConnectFrom(null);
      setHovered({ type: null, id: null });
      return;
    }

    if (isDragging) {
      setIsDragging(false);
      if (dragRef.current?.moved) commitHistory();
      dragRef.current = null;
    }
  };

  /* ----- wheel zoom (native, non-passive) ----- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e) => {
      // React attaches `wheel` at the root as a passive listener, so this must
      // be a native non-passive listener for preventDefault to work at all.
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cxv = e.clientX - rect.left;
      const cyv = e.clientY - rect.top;
      const { zoom: z, pan: p } = viewRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nextZoom = Math.min(5, Math.max(0.15, z * factor));
      const canvasX = (cxv - p.x) / z;
      const canvasY = (cyv - p.y) / z;
      setPan({ x: cxv - canvasX * nextZoom, y: cyv - canvasY * nextZoom });
      setZoom(nextZoom);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const zoomIn = () => setZoom((z) => Math.min(5, z * 1.2));
  const zoomOut = () => setZoom((z) => Math.max(0.15, z / 1.2));
  const zoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  /** Fit the given canvas-space bounds into the viewport. */
  const fitToBounds = useCallback((box) => {
    const canvas = canvasRef.current;
    if (!canvas || !box || box.w <= 0 || box.h <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const margin = 40;
    const nextZoom = Math.min(
      2,
      Math.max(0.15, Math.min((rect.width - margin * 2) / box.w, (rect.height - margin * 2) / box.h))
    );
    setZoom(nextZoom);
    setPan({
      x: rect.width / 2 - (box.x + box.w / 2) * nextZoom,
      y: rect.height / 2 - (box.y + box.h / 2) * nextZoom,
    });
  }, []);

  const zoomToFit = useCallback(() => {
    const box = boundsOfNodes(docRef.current.nodes);
    if (box) fitToBounds(box);
  }, [fitToBounds]);

  /* ----- keyboard shortcuts ----- */
  useEffect(() => {
    const onKeyDown = (e) => {
      const key = typeof e.key === "string" ? e.key : "";
      if (!key) return;
      const tag = e.target?.tagName;
      const inField =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable;
      const meta = e.metaKey || e.ctrlKey;
      const lower = key.toLowerCase();

      if (meta && lower === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && lower === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (inField) return;

      if (meta && lower === "a") {
        e.preventDefault();
        const all = docRef.current.nodes.map((n) => n.id);
        selectSet(all.length ? { type: "node", ids: all } : { type: null, ids: [] });
        return;
      }
      if (meta && lower === "d") {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (key === " ") {
        e.preventDefault();
        spaceHeld.current = true;
        return;
      }
      if (key === "Delete" || key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (key === "Escape") {
        selectSet({ type: null, ids: [] });
        setTool("select");
        setPendingShape(null);
        setIsConnecting(false);
        setConnectFrom(null);
        setMarquee(null);
        return;
      }
      if (lower === "v") setTool("select");
      else if (lower === "e") setTool("edge");
      else if (lower === "d") setTool("delete");
      else if (lower === "p") setTool("pan");
      else if (lower === "g") groupSelectionIntoCluster();
      else if (lower === "f") zoomToFit();
    };
    const onKeyUp = (e) => {
      if (e.key === " ") spaceHeld.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [undo, redo, deleteSelection, duplicateSelection, groupSelectionIntoCluster, zoomToFit, selectSet]);

  /* ----- canvas rendering ----- */
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const wantW = Math.max(1, Math.round(rect.width * dpr));
    const wantH = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = graphAttrs.bgcolor || "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);

    if (showGrid) {
      ctx.save();
      ctx.strokeStyle = "#eef2f7";
      ctx.lineWidth = 1;
      const step = GRID_SIZE * zoom;
      if (step > 4) {
        const startX = ((pan.x % step) + step) % step;
        const startY = ((pan.y % step) + step) % step;
        ctx.beginPath();
        for (let x = startX; x < rect.width; x += step) {
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, rect.height);
        }
        for (let y = startY; y < rect.height; y += step) {
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(rect.width, Math.round(y) + 0.5);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    for (const c of clusters) {
      const members = nodes.filter((n) => n.clusterId === c.id);
      drawCluster(ctx, c, members, selection.type === "cluster" && selectedIds.has(c.id));
    }

    for (const e of edges) {
      drawEdge(ctx, e, nodes, {
        selected: selection.type === "edge" && selectedIds.has(e.id),
        hovered: hovered.type === "edge" && hovered.id === e.id,
        fontname: graphAttrs.fontname,
        bgcolor: graphAttrs.bgcolor,
      });
    }

    if (isConnecting && connectFrom) {
      const src = nodes.find((n) => n.id === connectFrom);
      if (src) {
        ctx.save();
        ctx.strokeStyle = "#4f46e5";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        const start = clipToNode(nodeBounds(src), mousePos.x, mousePos.y);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(mousePos.x, mousePos.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    for (const n of nodes) {
      drawNode(ctx, n, {
        selected: selection.type === "node" && selectedIds.has(n.id),
        hovered: hovered.type === "node" && hovered.id === n.id,
        fontname: graphAttrs.fontname,
      });
    }

    if (marquee) {
      const r = normalizeRect(marquee.x1, marquee.y1, marquee.x2, marquee.y2);
      ctx.save();
      ctx.fillStyle = "rgba(79, 70, 229, 0.08)";
      ctx.strokeStyle = "#4f46e5";
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([4 / zoom, 3 / zoom]);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }

    ctx.restore();
  }, [
    nodes,
    edges,
    clusters,
    pan,
    zoom,
    showGrid,
    selection,
    selectedIds,
    hovered,
    isConnecting,
    connectFrom,
    mousePos,
    marquee,
    graphAttrs.bgcolor,
    graphAttrs.fontname,
  ]);

  const renderRef = useRef(render);
  useEffect(() => {
    renderRef.current = render;
  }, [render]);

  useEffect(() => {
    render();
  }, [render]);

  // The canvas is sized by CSS, so panel resizes and window resizes change its
  // backing store without changing any state the render effect depends on.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => renderRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  /* ----- autosave ----- */
  const autosaveRef = useRef({ projectName, createdTs, zoom, pan, showGrid });
  useEffect(() => {
    autosaveRef.current = { projectName, createdTs, zoom, pan, showGrid };
  }, [projectName, createdTs, zoom, pan, showGrid]);

  useEffect(() => {
    // Mounted once: a dependency-driven interval was torn down on every edit,
    // so it never survived long enough to fire while the user was working.
    let lastSaved = "";
    const id = setInterval(() => {
      try {
        const snapshot = buildProjectSnapshot({
          ...autosaveRef.current,
          ...docRef.current,
        });
        const json = JSON.stringify(snapshot);
        const comparable = JSON.stringify({ ...snapshot, modified: 0 });
        if (comparable === lastSaved) return;
        lastSaved = comparable;
        localStorage.setItem(AUTOSAVE_KEY, json);
      } catch {
        // storage full or unavailable — autosave is best-effort
      }
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const applyProject = useCallback(
    (data) => {
      docRef.current = {
        nodes: data.nodes,
        edges: data.edges,
        clusters: data.clusters,
        graphAttrs: data.graphAttrs,
      };
      setNodes(data.nodes);
      setEdges(data.edges);
      setClusters(data.clusters);
      setGraphAttrs(data.graphAttrs);
      setProjectName(data.name);
      if (data.viewport) {
        setZoom(toFinite(data.viewport.zoom, 1) || 1);
        setPan({
          x: toFinite(data.viewport.pan?.x, 0),
          y: toFinite(data.viewport.pan?.y, 0),
        });
        setShowGrid(data.viewport.showGrid ?? true);
      }
      nodeCounter.current = maxIdSuffix(data.nodes);
      edgeCounter.current = maxIdSuffix(data.edges);
      clusterCounter.current = maxIdSuffix(data.clusters);
      selectSet({ type: null, ids: [] });
      setHistory({ stack: [snapshotOf(docRef.current)], index: 0 });
    },
    [selectSet]
  );

  // Restore on mount. The ref guard keeps StrictMode's double effect from
  // showing the confirm dialog twice.
  const restoreAttempted = useRef(false);
  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = localStorage.getItem(AUTOSAVE_KEY);
        if (!raw) return;
        const data = parseProjectJson(raw);
        if (!data || (data.nodes.length === 0 && data.edges.length === 0)) return;
        // An in-app banner rather than window.confirm: a modal dialog blocks
        // the whole page (and every script on it) until it is dismissed.
        setRecoverable(data);
      } catch {
        // ignore unreadable autosave
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const acceptRecovery = useCallback(() => {
    if (recoverable) applyProject(recoverable);
    setRecoverable(null);
  }, [recoverable, applyProject]);

  const dismissRecovery = useCallback(() => {
    setRecoverable(null);
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {}
  }, []);

  /* ----- save / load / export ----- */
  const saveProject = () => {
    const snapshot = buildProjectSnapshot({ ...autosaveRef.current, ...docRef.current });
    downloadBlob(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      `${safeFilename(projectName)}.gv.json`
    );
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {}
  };

  const loadProject = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = parseProjectJson(await file.text());
        if (!data) {
          showToast("That file is not a valid project.");
          return;
        }
        applyProject(data);
      } catch (err) {
        showToast(err?.message || "Could not read that file.");
      }
    };
    input.click();
  };

  const exportPNG = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast("Could not export the canvas.");
        return;
      }
      downloadBlob(blob, `${safeFilename(projectName)}.png`);
    });
  };

  const downloadDot = () => {
    downloadBlob(new Blob([dotCode], { type: "text/vnd.graphviz" }), `${safeFilename(projectName)}.dot`);
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(dotCode);
      setCopied(true);
      later(() => setCopied(false), 1400);
    } catch {
      showToast("Clipboard access was denied.");
    }
  };

  /* ----- preview render ----- */
  const renderRequestId = useRef(0);

  // The server renders with the Graphviz WASM build, which emits SVG only.
  const renderPreview = useCallback(
    async () => {
      const requestId = ++renderRequestId.current;
      setRendering(true);
      setRenderError(null);
      setRenderProgress(5);
      const timer = setInterval(() => setRenderProgress((p) => (p < 90 ? p + 5 : p)), 200);
      const finish = () => {
        clearInterval(timer);
        if (renderRequestId.current === requestId) {
          setRendering(false);
          later(() => setRenderProgress(0), 400);
        }
      };
      try {
        const { graphAttrs: attrs } = docRef.current;
        const res = await fetch("/api/render-graphviz", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dotCode: generateDot(docRef.current),
            engine: attrs.preservePositions ? "neato" : attrs.engine,
            fixedPositions: attrs.preservePositions === true,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (renderRequestId.current !== requestId) return; // superseded
        setRenderProgress(100);
        if (!res.ok || !data.image) {
          setRenderError({
            message: data.error || `Render failed (HTTP ${res.status})`,
            details: data.details || null,
            rawOutput: data.rawOutput || null,
          });
          setPreview(null);
        } else {
          setPreview({ src: data.image, format: data.format });
        }
      } catch (err) {
        if (renderRequestId.current !== requestId) return;
        setRenderError({ message: err?.message || "Network error", details: null, rawOutput: null });
        setPreview(null);
      } finally {
        finish();
      }
    },
    [later]
  );

  /* ----- auto-layout ----- */
  const runAutoLayout = async () => {
    if (docRef.current.nodes.length === 0) return;
    setLayoutBusy(true);
    try {
      const res = await fetch("/api/auto-layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The generator always emits real on-canvas node sizes, so the
          // engine reserves the right space; dropping `pos` lets it choose
          // the positions.
          dotCode: generateDot({
            ...docRef.current,
            graphAttrs: { ...docRef.current.graphAttrs, preservePositions: false },
          }),
          engine: docRef.current.graphAttrs.engine,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.layout)) {
        showToast(data.error || `Layout failed (HTTP ${res.status})`);
        return;
      }
      const layoutMap = new Map(data.layout.map((l) => [l.id, l]));
      // Re-read the document: it may have changed while the request was in flight.
      const nextNodes = docRef.current.nodes.map((n) => {
        const l = layoutMap.get(n.id);
        if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) return n;
        return { ...n, x: l.x, y: l.y, modified: now() };
      });
      applyDoc({ nodes: nextNodes }, { commit: true });
      const box = boundsOfNodes(nextNodes);
      if (box) fitToBounds(box);
    } catch (err) {
      showToast(err?.message || "Could not reach the layout service.");
    } finally {
      setLayoutBusy(false);
    }
  };

  /* ----- panel resizers ----- */
  useEffect(() => {
    const onMove = (e) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (resizingDock.current) {
        setDockHeight(Math.min(700, Math.max(120, rect.bottom - e.clientY - 4)));
      } else if (resizingRail.current) {
        setRailWidth(Math.min(420, Math.max(180, e.clientX - rect.left)));
      } else if (resizingRight.current) {
        setRightWidth(Math.min(480, Math.max(220, rect.right - e.clientX)));
      }
    };
    const onUp = () => {
      resizingDock.current = false;
      resizingRail.current = false;
      resizingRight.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /* ----- presentation helpers ----- */
  const cursorClass = (() => {
    if (isPanning) return "cursor-grabbing";
    if (tool === "edge") return "cursor-crosshair";
    if (tool === "delete") return "cursor-not-allowed";
    if (tool === "pan") return "cursor-grab";
    if (tool === PLACEHOLDER_TOOL) return "cursor-copy";
    return "cursor-default";
  })();

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const stats = [
    plural(nodes.length, "node"),
    plural(edges.length, "edge"),
    clusters.length ? plural(clusters.length, "cluster") : null,
    selection.ids.length > 1 ? `${selection.ids.length} selected` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const canGroup = selection.type === "node" && selection.ids.length >= 2;

  return (
    <div className="gv-app">
      {/* ===== Top bar ===== */}
      <header className="gv-topbar">
        <div className="gv-brand">
          <div className="gv-brand-logo">⛓</div>
          <span>Graphviz Generator</span>
        </div>

        <div className="gv-divider" />

        <button
          className={cx("gv-btn gv-btn-icon", tool === "select" && "gv-btn-light")}
          onClick={() => setTool("select")}
          title="Select (V) — drag on empty canvas to rubber-band"
        >
          ▦
        </button>
        <button
          className={cx("gv-btn gv-btn-icon", tool === "edge" && "gv-btn-light")}
          onClick={() => setTool("edge")}
          title="Connect nodes (E)"
        >
          →
        </button>
        <button
          className={cx("gv-btn gv-btn-icon", tool === "delete" && "gv-btn-light")}
          onClick={() => setTool("delete")}
          title="Delete (D)"
        >
          ✕
        </button>
        <button
          className={cx("gv-btn gv-btn-icon", tool === "pan" && "gv-btn-light")}
          onClick={() => setTool("pan")}
          title="Pan (P, or hold Space)"
        >
          ✋
        </button>

        <div className="gv-divider" />

        <button
          className="gv-btn gv-btn-light"
          onClick={undo}
          disabled={history.index <= 0}
          title="Undo (Ctrl+Z)"
        >
          ↶ Undo
        </button>
        <button
          className="gv-btn gv-btn-light"
          onClick={redo}
          disabled={history.index >= history.stack.length - 1}
          title="Redo (Ctrl+Shift+Z)"
        >
          ↷ Redo
        </button>

        <div className="gv-divider" />

        <select
          className="gv-select"
          style={{ background: "#1e293b", color: "#e2e8f0", borderColor: "#334155" }}
          value={graphAttrs.engine}
          onChange={(e) =>
            applyDoc({ graphAttrs: { ...docRef.current.graphAttrs, engine: e.target.value } })
          }
          title="Layout engine"
        >
          {ENGINES.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>

        <button
          className="gv-btn gv-btn-light"
          onClick={runAutoLayout}
          disabled={layoutBusy || nodes.length === 0}
          title="Re-arrange every node with the selected engine"
        >
          {layoutBusy ? <span className="gv-spinner" /> : "✨"} Auto-layout
        </button>

        <div style={{ flex: 1 }} />

        <input
          className="gv-input"
          style={{ background: "#1e293b", color: "#e2e8f0", borderColor: "#334155", width: 160 }}
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Project name"
        />

        <button className="gv-btn gv-btn-light" onClick={saveProject} title="Save project JSON">
          💾
        </button>
        <button className="gv-btn gv-btn-light" onClick={loadProject} title="Load project JSON">
          📁
        </button>
        <button className="gv-btn gv-btn-light" onClick={exportPNG} title="Export canvas as PNG">
          🖼
        </button>
        <button
          className="gv-btn gv-btn-light"
          onClick={() => {
            if (window.confirm("Clear all nodes and edges?")) clearAll();
          }}
          title="Clear canvas"
        >
          🗑
        </button>

        <div className="gv-divider" />

        <button
          className="gv-btn gv-btn-primary"
          onClick={() => {
            setOutputOpen(true);
            setOutputTab("code");
          }}
        >
          {"</>"} View Code
        </button>
      </header>

      {/* ===== Body ===== */}
      <div className="gv-body" ref={containerRef}>
        {/* Left rail */}
        <aside className="gv-rail gv-scroll" style={{ "--rail-w": `${railWidth}px` }}>
          <div className="gv-rail-head">
            <span className="gv-rail-title">Nodes</span>
            <span className="text-[11px] text-slate-400">click to place</span>
          </div>
          <div className="gv-rail-search">
            <input
              className="gv-input"
              placeholder="Search shapes…"
              value={shapeSearch}
              onChange={(e) => setShapeSearch(e.target.value)}
            />
          </div>
          <div className="gv-cat-tabs">
            {["All", ...CATEGORIES].map((c) => (
              <button
                key={c}
                className={cx("gv-cat-tab", activeCat === c && "gv-cat-tab-active")}
                onClick={() => setActiveCat(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="gv-shape-grid gv-scroll">
            {filteredShapes.map((s) => (
              <button
                key={s.kind}
                className={cx("gv-shape-tile", pendingShape === s.kind && "gv-cat-tab-active")}
                onClick={() => {
                  setTool(PLACEHOLDER_TOOL);
                  setPendingShape(s.kind);
                }}
                title={`Place ${s.label}`}
              >
                <ShapeGlyph kind={s.kind} />
                <span className="gv-shape-tile-label">{s.label}</span>
              </button>
            ))}
          </div>
          <div style={{ padding: "10px", borderTop: "1px solid var(--gv-border)" }}>
            <button
              className="gv-btn gv-btn-ghost"
              style={{ width: "100%", justifyContent: "center", border: "1px solid var(--gv-border)" }}
              onClick={groupSelectionIntoCluster}
              disabled={!canGroup}
              title={
                canGroup
                  ? "Wrap the selected nodes into a cluster (G)"
                  : "Select two or more nodes to group them"
              }
            >
              📦 Group Selection
            </button>
          </div>
        </aside>

        <div
          className="gv-v-resizer"
          onMouseDown={() => {
            resizingRail.current = true;
            document.body.style.cursor = "ew-resize";
          }}
        />

        {/* Canvas column */}
        <div className="gv-canvas-col">
          <div className="gv-canvas-wrap">
            <canvas
              ref={canvasRef}
              className={cx("gv-canvas", cursorClass)}
              style={{ width: "100%", height: "100%", touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => {
                if (!isPanning && !isDragging && !isConnecting && !marquee) {
                  setHovered({ type: null, id: null });
                }
              }}
            />
            <div className="gv-status">{stats}</div>
            <div className="gv-zoom">
              <button className="gv-zoom-btn" onClick={zoomOut} title="Zoom out">
                −
              </button>
              <span className="gv-zoom-label">{Math.round(zoom * 100)}%</span>
              <button className="gv-zoom-btn" onClick={zoomIn} title="Zoom in">
                +
              </button>
              <button
                className="gv-zoom-btn"
                onClick={zoomToFit}
                title="Zoom to fit (F)"
                style={{ fontSize: 11 }}
              >
                ⤢
              </button>
              <button
                className="gv-zoom-btn"
                onClick={zoomReset}
                title="Reset view"
                style={{ fontSize: 11 }}
              >
                1:1
              </button>
            </div>
            {recoverable && (
              <div className="gv-recover" role="dialog" aria-label="Recover unsaved project">
                <span>
                  Recover unsaved project <strong>{recoverable.name}</strong> —{" "}
                  {recoverable.nodes.length} node{recoverable.nodes.length === 1 ? "" : "s"},{" "}
                  {recoverable.edges.length} edge{recoverable.edges.length === 1 ? "" : "s"}?
                </span>
                <button className="gv-btn gv-btn-primary" onClick={acceptRecovery}>
                  Recover
                </button>
                <button className="gv-btn gv-btn-light" onClick={dismissRecovery}>
                  Discard
                </button>
              </div>
            )}
            {toast && (
              <div
                className="gv-status"
                style={{
                  left: "50%",
                  right: "auto",
                  transform: "translateX(-50%)",
                  top: 12,
                  bottom: "auto",
                  color: toast.kind === "error" ? "var(--gv-danger)" : "inherit",
                  maxWidth: "70%",
                }}
                role="status"
              >
                {toast.message}
              </div>
            )}
          </div>

          {/* Output dock */}
          {outputOpen && (
            <div className="gv-dock" style={{ "--dock-h": `${dockHeight}px` }}>
              <div
                className="gv-dock-resizer"
                onMouseDown={() => {
                  resizingDock.current = true;
                  document.body.style.cursor = "ns-resize";
                }}
              />
              <div className="gv-dock-head">
                <div className="gv-segmented">
                  <button
                    className={cx("gv-seg-btn", outputTab === "code" && "gv-seg-btn-active")}
                    onClick={() => setOutputTab("code")}
                  >
                    {"</>"} DOT Code
                  </button>
                  <button
                    className={cx("gv-seg-btn", outputTab === "preview" && "gv-seg-btn-active")}
                    onClick={() => setOutputTab("preview")}
                  >
                    ▶ Preview
                  </button>
                </div>

                <div style={{ flex: 1 }} />

                {outputTab === "code" ? (
                  <>
                    <button className="gv-btn gv-btn-light" onClick={copyCode}>
                      {copied ? "✓ Copied" : "⧉ Copy"}
                    </button>
                    <button className="gv-btn gv-btn-light" onClick={downloadDot}>
                      ⭳ .dot
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="gv-btn gv-btn-primary"
                      onClick={() => renderPreview()}
                      disabled={rendering}
                    >
                      {rendering ? <span className="gv-spinner" /> : "▶"} Render
                    </button>
                    {rendering && (
                      <div className="gv-progress">
                        <div className="gv-progress-bar" style={{ width: `${renderProgress}%` }} />
                      </div>
                    )}
                  </>
                )}

                <button
                  className="gv-btn gv-btn-icon"
                  onClick={() => setOutputOpen(false)}
                  title="Close"
                >
                  ✕
                </button>
              </div>
              <div className="gv-dock-body">
                {outputTab === "code" ? (
                  <textarea className="gv-code-area gv-scroll" value={dotCode} readOnly spellCheck={false} />
                ) : (
                  <div className="gv-preview-wrap gv-scroll">
                    {clusters.length > 0 && graphAttrs.preservePositions !== false && (
                      <div
                        className="gv-tip"
                        style={{ position: "absolute", top: 10, left: 10, right: 10, zIndex: 2 }}
                      >
                        Cluster boxes are not drawn while <strong>Keep canvas positions</strong> is
                        on — Graphviz cannot lay clusters out around fixed node positions. Turn the
                        setting off in Graph settings to render them.
                      </div>
                    )}
                    {renderError ? (
                      <RenderErrorPanel error={renderError} />
                    ) : preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="gv-preview-img" src={preview.src} alt="Rendered graph" />
                    ) : (
                      <div style={{ color: "var(--gv-ink-faint)", fontSize: 13, textAlign: "center" }}>
                        Click <strong>Render</strong> to preview the diagram.
                        <br />
                        Rendered as SVG by the Graphviz engine.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div
          className="gv-v-resizer"
          onMouseDown={() => {
            resizingRight.current = true;
            document.body.style.cursor = "ew-resize";
          }}
        />

        {/* Right panel */}
        <aside className="gv-right gv-scroll" style={{ "--right-w": `${rightWidth}px` }}>
          <div className="gv-right-head">
            <span className="gv-right-title">
              {selectedElement
                ? `${selection.type} properties`
                : selection.ids.length > 1
                  ? `${selection.ids.length} nodes selected`
                  : "Graph settings"}
            </span>
            {selection.ids.length > 0 && (
              <button
                className="gv-btn gv-btn-icon gv-btn-ghost"
                onClick={() => selectSet({ type: null, ids: [] })}
                title="Clear selection"
              >
                ✕
              </button>
            )}
          </div>
          <div className="gv-right-body gv-scroll">
            {selectedElement ? (
              <PropertiesPanel
                element={selectedElement}
                type={selection.type}
                update={updateSelected}
                commit={commitHistory}
                onDuplicate={duplicateSelection}
                onDelete={deleteSelection}
                nodes={nodes}
                edges={edges}
              />
            ) : selection.ids.length > 1 ? (
              <MultiSelectPanel
                count={selection.ids.length}
                nodes={selectedNodes}
                update={updateSelected}
                onGroup={groupSelectionIntoCluster}
                onDuplicate={duplicateSelection}
                onDelete={deleteSelection}
              />
            ) : (
              <GraphSettingsPanel
                graphAttrs={graphAttrs}
                setGraphAttr={(key, value) =>
                  applyDoc({ graphAttrs: { ...docRef.current.graphAttrs, [key]: value } })
                }
                commit={commitHistory}
                showGrid={showGrid}
                setShowGrid={setShowGrid}
                snapToGrid={snapToGrid}
                setSnapToGrid={setSnapToGrid}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Topmost cluster whose padded bounding box contains the point. */
function clusterAt(doc, x, y) {
  for (let i = doc.clusters.length - 1; i >= 0; i--) {
    const c = doc.clusters[i];
    const members = doc.nodes.filter((n) => n.clusterId === c.id);
    const box = boundsOfNodes(members);
    if (!box) continue;
    const pad = 18;
    const inOuter =
      x >= box.x - pad && x <= box.x + box.w + pad && y >= box.y - pad && y <= box.y + box.h + pad;
    // Only the border band selects the cluster, so nodes inside stay clickable.
    const inInner = x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h;
    if (inOuter && !inInner) return c;
  }
  return null;
}

/* ============================================================
   Sub-components
   ============================================================ */

function RenderErrorPanel({ error }) {
  const notInstalled = /not configured/i.test(error.message || "");
  return (
    <div style={{ color: "var(--gv-danger)", maxWidth: 560, fontSize: 13, textAlign: "center" }}>
      <strong>{error.message}</strong>
      {error.details && (
        <div style={{ marginTop: 6, color: "var(--gv-ink-faint)", fontSize: 12 }}>{error.details}</div>
      )}
      {error.rawOutput && (
        <pre
          style={{
            marginTop: 10,
            fontSize: 11,
            textAlign: "left",
            whiteSpace: "pre-wrap",
            background: "white",
            padding: 10,
            borderRadius: 8,
            border: "1px solid var(--gv-border)",
            color: "var(--gv-ink)",
          }}
        >
          {error.rawOutput}
        </pre>
      )}
      {notInstalled && (
        <pre
          style={{
            marginTop: 10,
            fontSize: 11,
            textAlign: "left",
            whiteSpace: "pre-wrap",
            background: "white",
            padding: 10,
            borderRadius: 8,
            border: "1px solid var(--gv-border)",
            color: "var(--gv-ink)",
          }}
        >
          {"Install Graphviz:\n  macOS:   brew install graphviz\n  Ubuntu:  sudo apt-get install graphviz"}
        </pre>
      )}
    </div>
  );
}

function ShapeGlyph({ kind }) {
  const common = { width: 36, height: 26, stroke: "currentColor", strokeWidth: 1.5, fill: "none" };
  switch (kind) {
    case "box":
      return <svg {...common} viewBox="0 0 36 26"><rect x="3" y="5" width="30" height="16" rx="1" /></svg>;
    case "rounded":
      return <svg {...common} viewBox="0 0 36 26"><rect x="3" y="5" width="30" height="16" rx="6" /></svg>;
    case "ellipse":
      return <svg {...common} viewBox="0 0 36 26"><ellipse cx="18" cy="13" rx="15" ry="8" /></svg>;
    case "circle":
      return <svg {...common} viewBox="0 0 36 26"><circle cx="18" cy="13" r="9" /></svg>;
    case "doublecircle":
      return <svg {...common} viewBox="0 0 36 26"><circle cx="18" cy="13" r="10" /><circle cx="18" cy="13" r="7" /></svg>;
    case "diamond":
      return <svg {...common} viewBox="0 0 36 26"><path d="M18 3 L33 13 L18 23 L3 13 Z" /></svg>;
    case "Mdiamond":
      return (
        <svg {...common} viewBox="0 0 36 26">
          <path d="M18 3 L33 13 L18 23 L3 13 Z" />
          <path d="M11 8 L14 6 M25 8 L22 6 M11 18 L14 20 M25 18 L22 20" />
        </svg>
      );
    case "triangle":
      return <svg {...common} viewBox="0 0 36 26"><path d="M18 3 L33 22 L3 22 Z" /></svg>;
    case "parallelogram":
      return <svg {...common} viewBox="0 0 36 26"><path d="M8 5 L33 5 L28 21 L3 21 Z" /></svg>;
    case "hexagon":
      return <svg {...common} viewBox="0 0 36 26"><path d="M10 4 L26 4 L33 13 L26 22 L10 22 L3 13 Z" /></svg>;
    case "octagon":
      return <svg {...common} viewBox="0 0 36 26"><path d="M12 3 L24 3 L33 9 L33 17 L24 23 L12 23 L3 17 L3 9 Z" /></svg>;
    case "point":
      return <svg {...common} viewBox="0 0 36 26"><circle cx="18" cy="13" r="4" fill="currentColor" /></svg>;
    case "plaintext":
      return (
        <svg {...common} viewBox="0 0 36 26">
          <text x="18" y="17" textAnchor="middle" fontSize="11" fill="currentColor" stroke="none">
            abc
          </text>
        </svg>
      );
    case "record":
      return <svg {...common} viewBox="0 0 36 26"><rect x="3" y="4" width="30" height="18" /><line x1="3" y1="13" x2="33" y2="13" /></svg>;
    case "Mrecord":
      return <svg {...common} viewBox="0 0 36 26"><rect x="3" y="4" width="30" height="18" rx="5" /><line x1="3" y1="13" x2="33" y2="13" /></svg>;
    case "Msquare":
      return (
        <svg {...common} viewBox="0 0 36 26">
          <rect x="3" y="5" width="30" height="16" />
          <path d="M7 5 L3 9 M29 5 L33 9 M7 21 L3 17 M29 21 L33 17" />
        </svg>
      );
    default:
      return <svg {...common} viewBox="0 0 36 26"><rect x="3" y="5" width="30" height="16" rx="1" /></svg>;
  }
}

function Field({ label, children }) {
  return (
    <div className="gv-prop-row">
      <span className="gv-prop-label">{label}</span>
      <div className="gv-prop-field">{children}</div>
    </div>
  );
}

/** A number input that never renders NaN and commits on blur. */
function NumberField({ value, fallback = 0, onChange, onCommit, ...rest }) {
  return (
    <input
      type="number"
      className="gv-input"
      value={Number.isFinite(value) ? value : fallback}
      onChange={(e) => {
        const parsed = parseFloat(e.target.value);
        onChange(Number.isFinite(parsed) ? parsed : fallback);
      }}
      onBlur={onCommit}
      {...rest}
    />
  );
}

function ColorField({ value, fallback = "#ffffff", onChange, onCommit, onClear }) {
  const isTransparent = !value || value === "transparent";
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <input
        type="color"
        className="gv-color-swatch"
        value={isTransparent ? fallback : value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
      />
      {onClear ? (
        <button
          className="gv-btn gv-btn-light"
          style={{ height: 30, padding: "0 8px", fontSize: 11 }}
          onClick={onClear}
        >
          {isTransparent ? "✓ None" : "None"}
        </button>
      ) : (
        <input
          className="gv-input"
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
        />
      )}
    </div>
  );
}

function PropertiesPanel({ element, type, update, commit, onDuplicate, onDelete, nodes, edges }) {
  if (type === "node") return <NodeProperties {...{ element, update, commit, onDuplicate, onDelete }} />;
  if (type === "edge") return <EdgeProperties {...{ element, update, commit, onDelete, nodes, edges }} />;
  if (type === "cluster") return <ClusterProperties {...{ element, update, commit, onDelete }} />;
  return null;
}

function NodeProperties({ element, update, commit, onDuplicate, onDelete }) {
  const circular = isCircular(element.shape);
  const set = (key, value) => update(key, value);
  const setAndCommit = (key, value) => update(key, value, { commit: true });

  return (
    <>
      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Identity</div>
        <Field label="ID">
          <input className="gv-input" value={element.id} disabled />
        </Field>
        <Field label="Shape">
          <select
            className="gv-select"
            value={element.shape}
            onChange={(e) => {
              const newShape = e.target.value;
              // Backfill whichever size fields the new shape needs, so a swap
              // can never leave radius (or width/height) undefined.
              const size = defaultSizeFor(newShape);
              for (const [k, v] of Object.entries(size)) {
                if (!Number.isFinite(element[k])) update(k, v);
              }
              setAndCommit("shape", newShape);
            }}
          >
            {NODE_SHAPES.map((s) => (
              <option key={s.kind} value={s.kind}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Label">
          <input
            className="gv-input"
            value={element.label}
            onChange={(e) => set("label", e.target.value)}
            onBlur={commit}
            placeholder="Label text — \n makes a line break"
          />
        </Field>
      </div>

      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Geometry</div>
        <div className="gv-prop-grid-2">
          <Field label="X">
            <NumberField
              value={Math.round(element.x)}
              onChange={(v) => set("x", v)}
              onCommit={commit}
            />
          </Field>
          <Field label="Y">
            <NumberField
              value={Math.round(element.y)}
              onChange={(v) => set("y", v)}
              onCommit={commit}
            />
          </Field>
        </div>
        {circular ? (
          <Field label="Radius">
            <NumberField
              value={Math.round(element.radius ?? DEFAULT_RADIUS)}
              fallback={DEFAULT_RADIUS}
              min="1"
              onChange={(v) => set("radius", Math.max(1, v))}
              onCommit={commit}
            />
          </Field>
        ) : (
          <div className="gv-prop-grid-2">
            <Field label="W">
              <NumberField
                value={Math.round(element.width ?? DEFAULT_NODE_W)}
                fallback={DEFAULT_NODE_W}
                min="1"
                onChange={(v) => set("width", Math.max(1, v))}
                onCommit={commit}
              />
            </Field>
            <Field label="H">
              <NumberField
                value={Math.round(element.height ?? DEFAULT_NODE_H)}
                fallback={DEFAULT_NODE_H}
                min="1"
                onChange={(v) => set("height", Math.max(1, v))}
                onCommit={commit}
              />
            </Field>
          </div>
        )}
      </div>

      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Appearance</div>
        <Field label="Stroke">
          <ColorField
            value={element.strokeColor}
            onChange={(v) => set("strokeColor", v)}
            onCommit={commit}
          />
        </Field>
        <Field label="Fill">
          <ColorField
            value={element.fillColor}
            onChange={(v) => set("fillColor", v)}
            onCommit={commit}
            onClear={() => setAndCommit("fillColor", "transparent")}
          />
        </Field>
        <Field label="Line">
          <select
            className="gv-select"
            value={element.style}
            onChange={(e) => setAndCommit("style", e.target.value)}
          >
            {NODE_LINE_STYLES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Width">
          <input
            type="range"
            min="0.5"
            max="6"
            step="0.1"
            value={element.lineWidth}
            onChange={(e) => set("lineWidth", parseFloat(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            style={{ width: "100%" }}
          />
        </Field>
      </div>

      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Text</div>
        <div className="gv-prop-grid-2">
          <Field label="Size">
            <NumberField
              value={element.fontSize}
              fallback={13}
              min="1"
              onChange={(v) => set("fontSize", Math.max(1, v))}
              onCommit={commit}
            />
          </Field>
          <Field label="Color">
            <input
              type="color"
              className="gv-color-swatch"
              style={{ width: "100%" }}
              value={element.fontColor}
              onChange={(e) => set("fontColor", e.target.value)}
              onBlur={commit}
            />
          </Field>
        </div>
      </div>

      <div className="gv-prop-section">
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="gv-btn gv-btn-light"
            style={{ flex: 1, justifyContent: "center" }}
            onClick={onDuplicate}
          >
            ⧉ Duplicate
          </button>
          <button
            className="gv-btn gv-btn-danger"
            style={{ flex: 1, justifyContent: "center", background: "#fef2f2" }}
            onClick={onDelete}
          >
            ✕ Delete
          </button>
        </div>
      </div>
    </>
  );
}

function EdgeProperties({ element, update, commit, onDelete, nodes, edges }) {
  const set = (key, value) => update(key, value);
  const setAndCommit = (key, value) => update(key, value, { commit: true });

  // Re-pointing an endpoint must not create a self-loop or a duplicate edge —
  // both are rejected when drawing an edge, so they are rejected here too.
  const wouldConflict = (source, target) =>
    source === target ||
    edges.some((e) => e.id !== element.id && e.source === source && e.target === target);

  const endpointSelect = (field) => {
    const other = field === "source" ? element.target : element.source;
    return (
      <select
        className="gv-select"
        value={element[field]}
        onChange={(e) => setAndCommit(field, e.target.value)}
      >
        {nodes.map((n) => {
          const [source, target] = field === "source" ? [n.id, other] : [other, n.id];
          const disabled = n.id !== element[field] && wouldConflict(source, target);
          return (
            <option key={n.id} value={n.id} disabled={disabled}>
              {(n.label || n.id) + (disabled ? " — already connected" : "")}
            </option>
          );
        })}
      </select>
    );
  };

  return (
    <>
      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Connection</div>
        <Field label="ID">
          <input className="gv-input" value={element.id} disabled />
        </Field>
        <Field label="From">{endpointSelect("source")}</Field>
        <Field label="To">{endpointSelect("target")}</Field>
      </div>

      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Appearance</div>
        <Field label="Label">
          <input
            className="gv-input"
            value={element.label}
            onChange={(e) => set("label", e.target.value)}
            onBlur={commit}
            placeholder="Edge label"
          />
        </Field>
        <Field label="Style">
          <select
            className="gv-select"
            value={element.style}
            onChange={(e) => setAndCommit("style", e.target.value)}
          >
            {EDGE_STYLES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Arrow">
          <select
            className="gv-select"
            value={element.arrowhead}
            onChange={(e) => setAndCommit("arrowhead", e.target.value)}
          >
            {ARROWHEADS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Dir">
          <select
            className="gv-select"
            value={element.dir}
            onChange={(e) => setAndCommit("dir", e.target.value)}
          >
            {DIRS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Color">
          <ColorField value={element.color} onChange={(v) => set("color", v)} onCommit={commit} />
        </Field>
        <Field label="Width">
          <input
            type="range"
            min="0.5"
            max="6"
            step="0.1"
            value={element.penwidth}
            onChange={(e) => set("penwidth", parseFloat(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            style={{ width: "100%" }}
          />
        </Field>
      </div>

      <div className="gv-prop-section">
        <button
          className="gv-btn gv-btn-danger"
          style={{ width: "100%", justifyContent: "center", background: "#fef2f2" }}
          onClick={onDelete}
        >
          ✕ Delete Edge
        </button>
      </div>
    </>
  );
}

function ClusterProperties({ element, update, commit, onDelete }) {
  const set = (key, value) => update(key, value);
  return (
    <>
      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Cluster</div>
        <Field label="ID">
          <input className="gv-input" value={element.id} disabled />
        </Field>
        <Field label="Label">
          <input
            className="gv-input"
            value={element.label}
            onChange={(e) => set("label", e.target.value)}
            onBlur={commit}
          />
        </Field>
        <Field label="Border">
          <ColorField value={element.color} onChange={(v) => set("color", v)} onCommit={commit} />
        </Field>
        <Field label="Fill">
          <ColorField
            value={element.bgColor}
            onChange={(v) => set("bgColor", v)}
            onCommit={commit}
            onClear={() => update("bgColor", "transparent", { commit: true })}
          />
        </Field>
      </div>
      <div className="gv-prop-section">
        <button
          className="gv-btn gv-btn-danger"
          style={{ width: "100%", justifyContent: "center", background: "#fef2f2" }}
          onClick={onDelete}
        >
          ✕ Dissolve Cluster
        </button>
      </div>
    </>
  );
}

function MultiSelectPanel({ count, nodes, update, onGroup, onDuplicate, onDelete }) {
  const setAll = (key, value) => update(key, value, { commit: true });
  return (
    <>
      <div className="gv-prop-section">
        <div className="gv-prop-section-title">{count} nodes selected</div>
        <div style={{ fontSize: 12, color: "var(--gv-ink-faint)", padding: "0 2px 8px" }}>
          Changes apply to every selected node.
        </div>
        <Field label="Fill">
          <ColorField
            value={nodes[0]?.fillColor}
            onChange={(v) => setAll("fillColor", v)}
            onClear={() => setAll("fillColor", "transparent")}
          />
        </Field>
        <Field label="Stroke">
          <ColorField value={nodes[0]?.strokeColor} onChange={(v) => setAll("strokeColor", v)} />
        </Field>
        <Field label="Shape">
          <select
            className="gv-select"
            value={nodes[0]?.shape || "box"}
            onChange={(e) => {
              const shape = e.target.value;
              const size = defaultSizeFor(shape);
              for (const [k, v] of Object.entries(size)) update(k, v);
              setAll("shape", shape);
            }}
          >
            {NODE_SHAPES.map((s) => (
              <option key={s.kind} value={s.kind}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="gv-prop-section">
        <button
          className="gv-btn gv-btn-light"
          style={{ width: "100%", justifyContent: "center", marginBottom: 6 }}
          onClick={onGroup}
        >
          📦 Group into Cluster
        </button>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="gv-btn gv-btn-light"
            style={{ flex: 1, justifyContent: "center" }}
            onClick={onDuplicate}
          >
            ⧉ Duplicate
          </button>
          <button
            className="gv-btn gv-btn-danger"
            style={{ flex: 1, justifyContent: "center", background: "#fef2f2" }}
            onClick={onDelete}
          >
            ✕ Delete
          </button>
        </div>
      </div>
    </>
  );
}

function GraphSettingsPanel({
  graphAttrs,
  setGraphAttr,
  commit,
  showGrid,
  setShowGrid,
  snapToGrid,
  setSnapToGrid,
}) {
  const pinned = graphAttrs.preservePositions !== false;
  return (
    <>
      <div className="gv-empty">
        <div className="gv-empty-icon">⛓</div>
        <div>Select a node or edge to edit, or adjust graph settings below.</div>
      </div>

      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Output</div>
        <label className="gv-checkbox-row">
          <input
            type="checkbox"
            className="gv-checkbox"
            checked={pinned}
            onChange={(e) => {
              setGraphAttr("preservePositions", e.target.checked);
              commit();
            }}
          />
          Keep canvas positions
        </label>
        <div style={{ fontSize: 11, color: "var(--gv-ink-faint)", padding: "2px 2px 6px" }}>
          {pinned
            ? "The rendered diagram matches this canvas exactly. Layout options below are ignored."
            : "Graphviz lays the graph out itself using the options below."}
        </div>
      </div>

      <div className="gv-prop-section" style={{ opacity: pinned ? 0.45 : 1 }}>
        <div className="gv-prop-section-title">Layout</div>
        <Field label="Engine">
          <select
            className="gv-select"
            value={graphAttrs.engine}
            onChange={(e) => setGraphAttr("engine", e.target.value)}
            disabled={pinned}
          >
            {ENGINES.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rank dir">
          <select
            className="gv-select"
            value={graphAttrs.rankdir}
            onChange={(e) => setGraphAttr("rankdir", e.target.value)}
            disabled={pinned}
          >
            {RANKDIRS.map((r) => (
              <option key={r} value={r}>
                {r === "TB"
                  ? "TB — Top → Bottom"
                  : r === "LR"
                    ? "LR — Left → Right"
                    : r === "BT"
                      ? "BT — Bottom → Top"
                      : "RL — Right → Left"}
              </option>
            ))}
          </select>
        </Field>
        <div className="gv-prop-grid-2">
          <Field label="Node sep">
            <NumberField
              value={graphAttrs.nodesep}
              fallback={0.5}
              step="0.1"
              min="0"
              disabled={pinned}
              onChange={(v) => setGraphAttr("nodesep", v)}
              onCommit={commit}
            />
          </Field>
          <Field label="Rank sep">
            <NumberField
              value={graphAttrs.ranksep}
              fallback={0.75}
              step="0.1"
              min="0"
              disabled={pinned}
              onChange={(v) => setGraphAttr("ranksep", v)}
              onCommit={commit}
            />
          </Field>
        </div>
      </div>

      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Style</div>
        <Field label="Splines">
          <select
            className="gv-select"
            value={graphAttrs.splines}
            onChange={(e) => setGraphAttr("splines", e.target.value)}
          >
            {SPLINES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Background">
          <ColorField
            value={graphAttrs.bgcolor}
            onChange={(v) => setGraphAttr("bgcolor", v)}
            onCommit={commit}
          />
        </Field>
        <Field label="Font">
          <select
            className="gv-select"
            value={graphAttrs.fontname}
            onChange={(e) => setGraphAttr("fontname", e.target.value)}
          >
            {["Helvetica", "Arial", "Times-Roman", "Courier", "Verdana", "Georgia"].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="gv-prop-section">
        <div className="gv-prop-section-title">Canvas</div>
        <label className="gv-checkbox-row">
          <input
            type="checkbox"
            className="gv-checkbox"
            checked={showGrid}
            onChange={(e) => setShowGrid(e.target.checked)}
          />
          Show grid
        </label>
        <label className="gv-checkbox-row">
          <input
            type="checkbox"
            className="gv-checkbox"
            checked={snapToGrid}
            onChange={(e) => setSnapToGrid(e.target.checked)}
          />
          Snap to grid
        </label>
      </div>

      <div className="gv-tip">
        <strong>Quick start</strong>
        <br />
        1. Pick a node shape from the left rail and click on the canvas.
        <br />
        2. Press <span className="gv-kbd">E</span>, then drag from one node to another to add an edge.
        <br />
        3. Drag on empty canvas to rubber-band select; <span className="gv-kbd">G</span> groups the
        selection.
        <br />
        4. Hold <span className="gv-kbd">Space</span> to pan, <span className="gv-kbd">F</span> to fit.
        <br />
        5. <span className="gv-kbd">View Code</span> exports live DOT.
      </div>
    </>
  );
}
