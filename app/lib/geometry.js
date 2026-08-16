/**
 * Pure geometry helpers shared by the canvas renderer, hit-testing, and the
 * DOT generator. No React, no DOM — safe to unit test under `node --test`.
 */

export const DEFAULT_NODE_W = 110;
export const DEFAULT_NODE_H = 50;
export const DEFAULT_RADIUS = 38;

/** Graphviz works in inches; the canvas works in CSS pixels. */
export const PX_PER_INCH = 72;

/** Shapes that are sized by a radius rather than width/height. */
export const CIRCULAR_SHAPES = new Set(["circle", "doublecircle", "point"]);

export const isCircular = (shape) => CIRCULAR_SHAPES.has(shape);

export function nodeBounds(node) {
  if (isCircular(node.shape)) {
    const r = Number.isFinite(node.radius) ? node.radius : DEFAULT_RADIUS;
    return { x: node.x - r, y: node.y - r, w: r * 2, h: r * 2, cx: node.x, cy: node.y, r };
  }
  const w = Number.isFinite(node.width) ? node.width : DEFAULT_NODE_W;
  const h = Number.isFinite(node.height) ? node.height : DEFAULT_NODE_H;
  return { x: node.x - w / 2, y: node.y - h / 2, w, h, cx: node.x, cy: node.y, r: null };
}

export function nodeContainsPoint(node, px, py) {
  const b = nodeBounds(node);
  if (b.r) {
    return Math.hypot(px - b.cx, py - b.cy) <= b.r + 4;
  }
  if (node.shape === "diamond" || node.shape === "Mdiamond") {
    const dx = Math.abs(px - b.cx) / (b.w / 2);
    const dy = Math.abs(py - b.cy) / (b.h / 2);
    return dx + dy <= 1.05;
  }
  if (node.shape === "ellipse") {
    const dx = (px - b.cx) / (b.w / 2);
    const dy = (py - b.cy) / (b.h / 2);
    return dx * dx + dy * dy <= 1.05;
  }
  // Bounding-box approximation for every polygonal shape.
  return px >= b.x - 3 && px <= b.x + b.w + 3 && py >= b.y - 3 && py <= b.y + b.h + 3;
}

export function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Clip a ray from a node's centre toward `tx,ty` so it ends on the boundary. */
export function clipToNode(bounds, tx, ty) {
  const { cx, cy, w, h, r } = bounds;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  if (r) {
    const dist = Math.hypot(dx, dy);
    return { x: cx + (dx * r) / dist, y: cy + (dy * r) / dist };
  }
  const scaleX = dx === 0 ? Infinity : w / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : h / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** The drawn end points of an edge, clipped to both node boundaries. */
export function edgeEndpoints(edge, nodes) {
  const src = nodes.find((n) => n.id === edge.source);
  const tgt = nodes.find((n) => n.id === edge.target);
  if (!src || !tgt) return null;
  const sb = nodeBounds(src);
  const tb = nodeBounds(tgt);
  return {
    start: clipToNode(sb, tb.cx, tb.cy),
    end: clipToNode(tb, sb.cx, sb.cy),
  };
}

export function edgeContainsPoint(edge, nodes, px, py, tolerance = 6) {
  const ends = edgeEndpoints(edge, nodes);
  if (!ends) return false;
  const { start, end } = ends;
  return pointToSegmentDist(px, py, start.x, start.y, end.x, end.y) <= tolerance;
}

export function pointInRect(px, py, rx, ry, rw, rh) {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

/** Normalise a drag rectangle (either corner may be the origin). */
export function normalizeRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

/** True when a node's bounding box overlaps a marquee rectangle. */
export function nodeIntersectsRect(node, rect) {
  const b = nodeBounds(node);
  return (
    b.x < rect.x + rect.w && b.x + b.w > rect.x && b.y < rect.y + rect.h && b.y + b.h > rect.y
  );
}

/** Bounding box of a set of nodes, or null when there are none. */
export function boundsOfNodes(nodes) {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const b = nodeBounds(n);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
