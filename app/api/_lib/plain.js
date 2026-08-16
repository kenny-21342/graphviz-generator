/**
 * Parser for Graphviz `-Tplain` output.
 *
 *   graph scale width height
 *   node name x y width height label style shape color fillcolor
 *   edge tail head n x1 y1 ... [label xl yl] style color
 *   stop
 *
 * Coordinates are in inches with the origin at the bottom-left, and every
 * coordinate must be multiplied by the graph's `scale` factor.
 */

/**
 * Split a plain-format line into fields. Names and labels containing spaces
 * are emitted quoted, so a naive `split(/\s+/)` misaligns every field after
 * them.
 */
export function tokenizePlainLine(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i += 1;
    if (i >= line.length) break;
    if (line[i] === '"') {
      i += 1;
      let value = "";
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) {
          value += line[i + 1];
          i += 2;
        } else {
          value += line[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push(value);
    } else {
      let value = "";
      while (i < line.length && !/\s/.test(line[i])) {
        value += line[i];
        i += 1;
      }
      tokens.push(value);
    }
  }
  return tokens;
}

export function parsePlain(text) {
  let graph = null;
  const nodes = [];

  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = tokenizePlainLine(line);
    const kind = parts[0];

    if (kind === "graph") {
      const scale = parseFloat(parts[1]);
      graph = {
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
        width: parseFloat(parts[2]),
        height: parseFloat(parts[3]),
      };
    } else if (kind === "node") {
      const [, name, xs, ys, ws, hs] = parts;
      const x = parseFloat(xs);
      const y = parseFloat(ys);
      const w = parseFloat(ws);
      const h = parseFloat(hs);
      // A node without finite coordinates cannot be placed; a non-finite size
      // would poison the bounding box, so fall back to zero.
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      nodes.push({
        id: name,
        xInches: x,
        yInches: y,
        widthInches: Number.isFinite(w) ? w : 0,
        heightInches: Number.isFinite(h) ? h : 0,
      });
    }
    // `edge` and `stop` lines carry no information we need.
  }

  const scale = graph?.scale ?? 1;
  if (scale !== 1) {
    for (const n of nodes) {
      n.xInches *= scale;
      n.yInches *= scale;
      n.widthInches *= scale;
      n.heightInches *= scale;
    }
    if (Number.isFinite(graph.width)) graph.width *= scale;
    if (Number.isFinite(graph.height)) graph.height *= scale;
  }

  return { graph, nodes };
}

/**
 * Convert parsed inch coordinates into top-left-origin pixels.
 * Returns node centres, matching the canvas's own centre-based coordinates.
 */
export function toPixelLayout({ graph, nodes }, { pxPerInch = 72, margin = 40 } = {}) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const n of nodes) {
    const halfW = n.widthInches / 2;
    const halfH = n.heightInches / 2;
    minX = Math.min(minX, n.xInches - halfW);
    maxX = Math.max(maxX, n.xInches + halfW);
    minY = Math.min(minY, n.yInches - halfH);
    maxY = Math.max(maxY, n.yInches + halfH);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxY)) {
    const gw = Number.isFinite(graph?.width) ? graph.width : 0;
    const gh = Number.isFinite(graph?.height) ? graph.height : 0;
    minX = 0;
    minY = 0;
    maxX = gw;
    maxY = gh;
  }

  const layout = nodes.map((n) => ({
    id: n.id,
    // Flip Y so the origin is top-left, matching the canvas.
    x: Math.round((n.xInches - minX) * pxPerInch + margin),
    y: Math.round((maxY - n.yInches) * pxPerInch + margin),
    width: n.widthInches * pxPerInch,
    height: n.heightInches * pxPerInch,
  }));

  return {
    layout,
    bounds: {
      width: Math.round((maxX - minX) * pxPerInch + margin * 2),
      height: Math.round((maxY - minY) * pxPerInch + margin * 2),
    },
  };
}
