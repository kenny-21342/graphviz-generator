# Graphviz Generator

A visual editor for [Graphviz](https://graphviz.org/) diagrams. Sketch nodes and edges on a canvas, auto-layout with the `dot` engine (and friends), and export clean DOT code. Graphviz runs as a WebAssembly module on the server, so there is no native binary to install and the app deploys to any host that runs Node — Vercel included.

## Features

- **Visual canvas editor** — place 16 node shapes, connect them with directed/undirected edges, drag to reposition, real-time rendering.
- **Full node palette** — box, rounded, ellipse, circle, diamond, plaintext, triangle, parallelogram, hexagon, octagon, doublecircle, point, record, Mrecord, Mdiamond, Msquare.
- **Full edge styling** — per-edge arrowhead (`normal`, `vee`, `empty`, `odot`, `diamond`, `box`, `crow`, `inv`, `none`), line style (`solid`, `dashed`, `dotted`, `bold`, `tapered`), direction (`forward`, `back`, `both`, `none`), label, color, pen width.
- **Layout engines** — `dot`, `neato`, `fdp`, `sfdp`, `circo`, `twopi`.
- **Graph attributes panel** — `rankdir`, `splines`, `nodesep`, `ranksep`, `bgcolor`, `fontname`.
- **Auto-layout button** — sends the current graph to the selected engine, parses returned positions (`-Tplain` format), and snaps every node into place.
- **Clusters/subgraphs** — wrap all nodes into a labeled `subgraph cluster_X` with border and fill color.
- **Live DOT code** — the output dock updates in real time as you edit. Copy to clipboard or download `.dot`.
- **Preview render** — renders the DOT to an SVG server-side, with a progress bar.
- **Editor systems** — undo/redo (30-level history), save/load project JSON, autosave to `localStorage` every 30s with restore-on-reload, export canvas as PNG, zoom/pan/grid/snap, keyboard shortcuts.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **UI**: React 19, Tailwind CSS 4
- **Rendering**: HTML5 Canvas
- **Layout / preview**: Graphviz compiled to WebAssembly ([`@hpcc-js/wasm-graphviz`](https://github.com/hpcc-systems/hpcc-js-wasm)), server-side

## Getting Started

### Prerequisites

- Node.js 18+

That is the whole list. Graphviz ships with the app as a WASM module (`npm install` pulls it in), so no system package and no `dot` binary on `PATH` is required — in development, in production, or in tests.

### Installation

```bash
cd graphviz-generator
npm install
npm run dev
```

Open <http://localhost:3000>.

### Usage

1. **Add a node** — pick a shape from the left rail, then click on the canvas.
2. **Connect nodes** — press `E` (or click the → button), then drag from one node to another.
3. **Edit** — select any element to edit its properties in the right panel.
4. **Auto-layout** — click **✨ Auto-layout** to arrange everything with the selected engine.
5. **View code** — click **`</>` View Code** to open the live DOT output; copy or download `.dot`.
6. **Preview** — switch to the Preview tab and click **Render** to see the diagram as Graphviz draws it.

### Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `V` | Select tool |
| `E` | Edge (connect) tool |
| `D` | Delete tool |
| `P` | Pan tool |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Delete` / `Backspace` | Delete selected |
| `Escape` | Deselect / cancel |
| `Ctrl+A` | Select all nodes |
| `Ctrl+D` | Duplicate selection |
| `G` | Group selected nodes into a cluster |
| `F` | Zoom to fit |
| Hold `Space` | Pan (any tool) |
| Drag on empty canvas | Rubber-band select |
| `Shift`/`Cmd` + click | Add or remove a node from the selection |
| Mouse wheel | Zoom (cursor-anchored) |

## Architecture

- `app/page.js` — main editor: canvas, selection, drag, history, properties panels, output dock.
- `app/lib/dot.js` — DOT generation (escaping, quoting, node/edge attributes, clusters, pinned positions).
- `app/lib/geometry.js` — node bounds, hit-testing, edge clipping, marquee maths.
- `app/api/_lib/graphviz.js` — loads the Graphviz WASM module once per process and provides `runGraphviz(dot, { format, engine, fixedPositions })`.
- `app/api/_lib/guard.js` — request guards for the render endpoints: size cap, concurrency limit, and rejection of DOT attributes that read server files.
- `app/api/_lib/plain.js` — parser for Graphviz `-Tplain` output (quote-aware, applies the graph scale factor).
- `app/api/render-graphviz/route.js` — renders SVG and returns it as a base64 data URI.
- `app/api/auto-layout/route.js` — asks the engine for `plain` output and returns pixel-space node centres plus bounds.
- `app/globals.css` — `gv-*` design system (dark slate header, indigo accents, light canvas).

DOT code generation is **local and deterministic** (`generateDot` in `app/lib/dot.js`) — it runs entirely in the browser on every edit. No API key required.

### Canvas positions vs. engine layout

By default (**Keep canvas positions**, in Graph settings) every node is emitted with a
`pos="x,-y!"` attribute plus its real width and height in inches, and the preview is rendered in
no-op layout mode (the `-n` flag's WASM equivalent), so the output matches the canvas exactly. Turning the setting off drops `pos` and lets the
selected engine lay the graph out using `rankdir`, `nodesep`, and `ranksep`; node sizes are still
emitted so the engine reserves the right amount of space. **Auto-layout** always asks the engine
for fresh positions and writes them back to the canvas.

## Tests

```bash
npm test
```

Unit tests cover DOT generation and the `-Tplain` parser. `test/render.test.mjs` additionally pipes
the generated DOT through the real Graphviz engine in both position modes and checks that all six
layout engines place every node. Nothing is skipped — the WASM build is always available.

## Production

```bash
npm run build
npm start
```

Both API routes run Graphviz in-process as WebAssembly — no subprocess, no temp files, no system
package — so they deploy to a serverless host (Vercel included) as-is. The WASM binary is embedded
in the JavaScript bundle, so there is no separate `.wasm` asset to configure.

They declare `runtime = "nodejs"`: the module instantiates fine in a serverless Node function but
not on the edge runtime. The module is compiled once per process and cached, so the first request
to a cold instance pays a small load cost and later ones do not.

The editor itself — canvas, DOT generation, save/load, `.dot` export — is entirely client-side and
works regardless.

### Exposure notes

The render endpoints are unauthenticated and hand user-supplied DOT to the Graphviz engine. Before
exposing them publicly, review `app/api/_lib/guard.js`: it caps the source at 256 KB, allows four
concurrent renders, refuses attributes that make Graphviz read server files (`image`, `shapefile`,
`fontpath`, …), and withholds non-syntax diagnostics in production. Rendered SVG is returned as a
`data:` URI and shown in an `<img>`, never inlined into the DOM.

Note that WASM layout is synchronous and cannot be interrupted, so there is no per-render timeout
the way there was with a killable subprocess; a pathological graph blocks its own request until it
finishes. The 256 KB source cap and the concurrency limit are what bound that.

## License

MIT
