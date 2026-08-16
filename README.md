# Graphviz Generator

A visual editor for [Graphviz](https://graphviz.org/) diagrams. Sketch nodes and edges on a canvas, auto-layout with the `dot` engine (and friends), and export clean DOT code.

## Features

- **Visual canvas editor** — place 16 node shapes, connect them with directed/undirected edges, drag to reposition, real-time rendering.
- **Full node palette** — box, rounded, ellipse, circle, diamond, plaintext, triangle, parallelogram, hexagon, octagon, doublecircle, point, record, Mrecord, Mdiamond, Msquare.
- **Full edge styling** — per-edge arrowhead (`normal`, `vee`, `empty`, `odot`, `diamond`, `box`, `crow`, `inv`, `none`), line style (`solid`, `dashed`, `dotted`, `bold`, `tapered`), direction (`forward`, `back`, `both`, `none`), label, color, pen width.
- **Layout engines** — `dot`, `neato`, `fdp`, `sfdp`, `circo`, `twopi`.
- **Graph attributes panel** — `rankdir`, `splines`, `nodesep`, `ranksep`, `bgcolor`, `fontname`.
- **Auto-layout button** — sends the current graph to the selected engine, parses returned positions (`dot -Tplain`), and snaps every node into place.
- **Clusters/subgraphs** — wrap all nodes into a labeled `subgraph cluster_X` with border and fill color.
- **Live DOT code** — the output dock updates in real time as you edit. Copy to clipboard or download `.dot`.
- **Preview render** — renders the DOT to a PNG via the `dot` binary, with a progress bar.
- **Editor systems** — undo/redo (30-level history), save/load project JSON, autosave to `localStorage` every 30s with restore-on-reload, export canvas as PNG, zoom/pan/grid/snap, keyboard shortcuts.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **UI**: React 19, Tailwind CSS 4
- **Rendering**: HTML5 Canvas
- **Layout / preview**: Graphviz `dot` binary (server-side)

## Getting Started

### Prerequisites

- Node.js 18+
- The Graphviz `dot` binary — only required for **preview rendering** and **auto-layout** (the editor and DOT generation work without it):
  - macOS: `brew install graphviz`
  - Ubuntu/Debian: `sudo apt-get install graphviz`
  - Windows: <https://graphviz.org/download/>

> **Note on PATH resolution.** `child_process.execFile` does not run a login shell, so when the dev server is launched from an IDE, GUI app, or service manager, the PATH it inherits frequently omits the directory where Homebrew/MacPorts installed Graphviz (e.g. `/opt/homebrew/bin` on Apple Silicon). The API routes automatically probe a list of well-known install directories (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/local/bin`) as a fallback, so `dot` is found even when not on the launching process's PATH.

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
6. **Preview** — switch to the Preview tab and click **Render** (requires `dot` on PATH).

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
- `app/api/_lib/graphviz.js` — resolves the Graphviz binary to an absolute path (handles launchers whose PATH omits Homebrew/MacPorts dirs) and provides a `runGraphviz()` wrapper around `execFile`.
- `app/api/_lib/guard.js` — request guards for the render endpoints: size cap, concurrency limit, and rejection of DOT attributes that read server files.
- `app/api/_lib/plain.js` — parser for Graphviz `-Tplain` output (quote-aware, applies the graph scale factor).
- `app/api/render-graphviz/route.js` — shells out to `<engine> -T{png,svg}`, returns a base64 data URI.
- `app/api/auto-layout/route.js` — shells out to `<engine> -Tplain` and returns pixel-space node centres plus bounds.
- `app/globals.css` — `gv-*` design system (dark slate header, indigo accents, light canvas).

DOT code generation is **local and deterministic** (`generateDot` in `app/lib/dot.js`) — it runs entirely in the browser on every edit. No API key required.

### Canvas positions vs. engine layout

By default (**Keep canvas positions**, in Graph settings) every node is emitted with a
`pos="x,-y!"` attribute plus its real width and height in inches, and the preview is rendered with
`-n`, so the output matches the canvas exactly. Turning the setting off drops `pos` and lets the
selected engine lay the graph out using `rankdir`, `nodesep`, and `ranksep`; node sizes are still
emitted so the engine reserves the right amount of space. **Auto-layout** always asks the engine
for fresh positions and writes them back to the canvas.

## Tests

```bash
npm test
```

Unit tests cover DOT generation and the `-Tplain` parser. `test/render.test.mjs` additionally pipes
the generated DOT through the real `dot` binary in both position modes; it is skipped automatically
when Graphviz is not installed.

## Production

```bash
npm run build
npm start
```

Both API routes spawn the Graphviz binary and write to a temp directory, so they declare
`runtime = "nodejs"` and **cannot run on an edge/serverless runtime that lacks `dot`** — including
Vercel's default serverless environment, where preview and auto-layout will return
"Graphviz is not configured on this server." Deploy to a host where you control the image (a
container, a VM, or a platform build that installs Graphviz) and make sure `dot` is on `PATH`.

The editor itself — canvas, DOT generation, save/load, `.dot` export — works anywhere, with or
without the binary.

### Exposure notes

The render endpoints are unauthenticated and hand user-supplied DOT to a subprocess. Before
exposing them publicly, review `app/api/_lib/guard.js`: it caps the source at 256 KB, allows four
concurrent renders, refuses attributes that make Graphviz read server files (`image`, `shapefile`,
`fontpath`, …), and withholds subprocess stderr in production. Rendered SVG is returned as a
`data:` URI and shown in an `<img>`, never inlined into the DOM.

## License

MIT
