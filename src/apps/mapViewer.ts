// MCP App (MCP Apps extension): a globe / flat map of the places mentioned in a search, shown in
// the chat when map_documents runs, in clients that support MCP Apps.
//
// Self-contained, like the scan viewer: d3-geo and topojson-client are inlined, and so is the
// land outline (Natural Earth 1:50m via world-atlas), so the page needs no tile server and no
// network access. Only land is drawn, no modern borders: they would be anachronistic for the
// places of the VOC archives. Clicking a place lists its documents by calling search_documents
// through the host (tools/call) with the same filters plus that place.
//
// The host bridge follows @modelcontextprotocol/ext-apps, as in scanViewer.ts.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const MAP_VIEWER_URI = 'ui://globalise/map-viewer.html';
const MCP_APP_MIME = 'text/html;profile=mcp-app';
const PROTOCOL_VERSION = '2026-01-26';

export const mapViewerToolMeta = { ui: { resourceUri: MAP_VIEWER_URI }, 'ui/resourceUri': MAP_VIEWER_URI };

const RESOURCE_META = { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } };

let cachedHtml: string | null = null;

/** A file inside an installed package, also when the package's "exports" hide it. */
function readPackageFile(pkg: string, file: string): string {
  const require = createRequire(import.meta.url);
  let dir: string;
  try {
    dir = dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    dir = dirname(require.resolve(pkg));
  }
  while (!existsSync(join(dir, 'package.json')) || JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== pkg) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`Package ${pkg} not found`);
    dir = up;
  }
  return readFileSync(join(dir, file), 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '');
}

/** Inline <script> content must not close the tag early. */
const inline = (source: string) => source.replace(/<\/(script)/gi, '<\\/$1');

export function registerMapViewer(server: McpServer) {
  server.registerResource(
    'globalise-map-viewer',
    MAP_VIEWER_URI,
    { title: 'Globalise map of search results', mimeType: MCP_APP_MIME, _meta: RESOURCE_META },
    async (uri) => {
      cachedHtml ??= mapHtml({
        d3Array: readPackageFile('d3-array', 'dist/d3-array.min.js'),
        d3Geo: readPackageFile('d3-geo', 'dist/d3-geo.min.js'),
        topojson: readPackageFile('topojson-client', 'dist/topojson-client.min.js'),
        land: readPackageFile('world-atlas', 'land-50m.json'),
      });
      return { contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: cachedHtml, _meta: RESOURCE_META }] };
    },
  );
}

export function mapHtml(libs: { d3Array: string; d3Geo: string; topojson: string; land: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Globalise map</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1b; --muted: #6b6b66; --bg: #ffffff; --panel: #f7f6f2; --line: #e2e0da; --accent: #8a3b12;
          --ocean: #eef2f4; --land: #dcd6c8; --grid: rgba(60, 70, 80, .10); --dot: rgba(178, 74, 22, .62); --dot-line: #7a2e0b; --sel: #1f5f8b; --outline: #1f5f8b; --view-h: 520px; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ecebe6; --muted: #a3a29b; --bg: #1c1c1a; --panel: #242421; --line: #3a3935; --accent: #e8925f;
          --ocean: #1f2a30; --land: #4a4740; --grid: rgba(255, 255, 255, .08); --dot: rgba(232, 146, 95, .70); --dot-line: #f6c7a8; --sel: #7cc4f2; --outline: #7cc4f2; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, -apple-system, sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 8px 12px; }
  .title { flex: 1 1 240px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
  .meta { color: var(--muted); font-size: 12px; }
  .controls { display: flex; gap: 4px; align-items: center; }
  button { font: inherit; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  button.link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; cursor: pointer; }
  #statusbar { display: flex; gap: 8px; align-items: baseline; padding: 3px 12px 6px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  #status { flex: 1; min-width: 0; }
  #status.warn { color: var(--accent); }
  #details { font-size: 11px; padding: 0 6px; }
  #log { display: none; margin: 0; padding: 6px 12px; border-bottom: 1px solid var(--line); font: 11px/1.4 ui-monospace, monospace; white-space: pre-wrap; color: var(--muted); max-height: 160px; overflow: auto; }
  #log.open { display: block; }
  main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); height: var(--view-h); }
  body.fill { height: var(--fill-h); display: flex; flex-direction: column; overflow: hidden; }
  body.fill main { flex: 1 1 auto; height: auto; min-height: 0; }
  body.narrow main { grid-template-columns: 1fr; grid-template-rows: 62% 38%; }
  #mapwrap { position: relative; min-width: 0; min-height: 0; background: var(--bg); }
  canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
  canvas.dragging { cursor: grabbing; }
  #zoom { position: absolute; top: 8px; left: 8px; display: flex; flex-direction: column; gap: 4px; }
  #zoom button { width: 30px; padding: 3px 0; }
  #tip { position: absolute; pointer-events: none; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.15); display: none; max-width: 260px; }
  #legend { position: absolute; bottom: 6px; left: 8px; font-size: 11px; color: var(--muted); background: color-mix(in srgb, var(--bg) 80%, transparent); padding: 2px 6px; border-radius: 4px; }
  #side { overflow: auto; border-left: 1px solid var(--line); background: var(--panel); padding: 10px 12px; min-height: 0; }
  body.narrow #side { border-left: 0; border-top: 1px solid var(--line); }
  #side h2 { font: 600 11px/1.2 system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 4px 2px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .row:hover { color: var(--accent); }
  .bar { grid-column: 1 / -1; height: 3px; background: var(--dot); border-radius: 2px; }
  .num { font-variant-numeric: tabular-nums; color: var(--muted); }
  .doc { padding: 6px 0; border-bottom: 1px solid var(--line); }
  .doc .t { font-weight: 600; }
  .doc .s { color: var(--muted); font: 12px/1.45 Georgia, serif; margin-top: 2px; }
  .note { color: var(--muted); font-size: 12px; margin: 8px 0; }
  footer { padding: 4px 12px 8px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<header>
  <span class="title" id="title">Globalise map</span>
  <span class="meta" id="summary"></span>
  <span class="controls">
    <button id="globe" aria-pressed="true" title="Globe">Globe</button>
    <button id="flat" aria-pressed="false" title="Flat map (Equal Earth)">Map</button>
  </span>
  <span class="controls">
    <button id="bydocs" aria-pressed="true" title="Point size: number of matching documents">Documents</button>
    <button id="byrate" aria-pressed="false" title="Point size: matching documents per 1000 documents mentioning the place">Per 1000</button>
  </span>
  <span class="controls"><button id="expand" hidden title="Show larger">Expand</button></span>
</header>
<div id="statusbar"><span id="status">Starting…</span><button id="details" title="Show diagnostics">details</button></div>
<pre id="log"></pre>
<main>
  <div id="mapwrap">
    <canvas id="map"></canvas>
    <div id="zoom"><button id="zin" title="Zoom in">+</button><button id="zout" title="Zoom out">−</button><button id="zhome" title="Fit to the places">⤢</button></div>
    <div id="tip"></div>
    <div id="legend"></div>
  </div>
  <div id="side"><h2>Places</h2><div id="sidebody" class="note">Waiting for results…</div></div>
</main>
<footer id="footer">Points: coordinates of linked place records (one point per place, no boundaries). Land: Natural Earth, modern coastlines. Drag to rotate or pan; ctrl/⌘ + scroll or the buttons to zoom.</footer>
<script>
window.__log = [];
window.__diag = function (line) {
  window.__log.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  var el = document.getElementById('log');
  if (el) el.textContent = window.__log.join('\\n');
};
window.addEventListener('error', function (e) { window.__diag('error: ' + e.message); });
window.addEventListener('unhandledrejection', function (e) { window.__diag('unhandled rejection: ' + (e.reason && e.reason.message || e.reason)); });
</script>
<script>${inline(libs.d3Array)}</script>
<script>${inline(libs.d3Geo)}</script>
<script>${inline(libs.topojson)}</script>
<script>window.__LAND = ${inline(libs.land)};</script>
<script>
(() => {
  const PROTOCOL_VERSION = ${JSON.stringify(PROTOCOL_VERSION)};
  const $ = (id) => document.getElementById(id);
  const diag = window.__diag;
  const status = (text, warn) => { $('status').textContent = text; $('status').className = warn ? 'warn' : ''; diag((warn ? 'WARN ' : '') + text); };
  let nextId = 1;
  const pending = new Map();
  let hostContext = {};

  // --- Host bridge -----------------------------------------------------------------------------
  const send = (msg) => window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject({ message: method + ' timed out' }); } }, 60000);
  });
  const notify = (method, params) => send({ method, params });

  window.addEventListener('message', (event) => {
    if (event.source && event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && !msg.method) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      msg.error ? entry.reject(msg.error) : entry.resolve(msg.result);
      return;
    }
    diag('host → ' + msg.method);
    switch (msg.method) {
      case 'ping': send({ id: msg.id, result: {} }); break;
      case 'ui/notifications/tool-input': status('Counting places in the results…'); break;
      case 'ui/notifications/tool-result': load(msg.params); break;
      case 'ui/notifications/host-context-changed': applyHostContext({ ...hostContext, ...(msg.params || {}) }); break;
      case 'ui/notifications/tool-cancelled': status('The tool call was cancelled.', true); break;
      case 'ui/resource-teardown': send({ id: msg.id, result: {} }); break;
      default: if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
    }
  });

  // --- Sizing (as in the scan viewer) ---------------------------------------------------------
  function applyHostContext(context) {
    hostContext = context || {};
    const dims = hostContext.containerDimensions || {};
    const fixed = typeof dims.height === 'number' ? dims.height : null;
    const max = typeof dims.maxHeight === 'number' ? dims.maxHeight : null;
    const fullscreen = hostContext.displayMode === 'fullscreen';
    const root = document.documentElement;
    const fillHeight = fullscreen ? (fixed ? fixed + 'px' : '100vh') : fixed ? fixed + 'px' : null;
    document.body.classList.toggle('fill', !!fillHeight);
    if (fillHeight) root.style.setProperty('--fill-h', fillHeight);
    const chromeH = document.querySelector('header').offsetHeight + $('statusbar').offsetHeight + $('footer').offsetHeight;
    const viewH = max ? Math.max(260, Math.min(540, max - chromeH - 20)) : 540;
    root.style.setProperty('--view-h', viewH + 'px');
    const modes = hostContext.availableDisplayModes || [];
    $('expand').hidden = !modes.includes('fullscreen');
    $('expand').textContent = fullscreen ? 'Shrink' : 'Expand';
    resize();
  }
  let lastW = 0, lastH = 0, scheduled = false;
  function reportSize() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const root = document.documentElement;
      const previous = root.style.height;
      root.style.height = 'max-content';
      const height = Math.ceil(root.getBoundingClientRect().height);
      root.style.height = previous;
      const width = Math.ceil(window.innerWidth);
      if (width !== lastW || height !== lastH) { lastW = width; lastH = height; notify('ui/notifications/size-changed', { width, height }); }
    });
  }
  const observer = new ResizeObserver(() => { resize(); reportSize(); });

  // --- Map state ------------------------------------------------------------------------------
  if (!window.d3 || !d3.geoOrthographic || !window.topojson) { status('The map libraries did not load; see details.', true); return; }
  const land = topojson.feature(window.__LAND, window.__LAND.objects.land);
  const graticule = d3.geoGraticule10();
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  let width = 600, height = 400, dpr = 1;
  let mode = 'globe';
  let sizeBy = 'documents';
  let data = null;
  let points = [];       // places with coordinates
  let selected = null;
  let screen = [];       // drawn points for hit testing
  let rotation = [0, 0]; // [lambda, phi]
  let scale = 200;       // projection scale
  let baseScale = 200;
  let flatTranslateY = 0;
  let markSearched = false; // only when some, not all, places on the map were searched for
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function projection() {
    if (mode === 'globe') return d3.geoOrthographic().rotate(rotation).scale(scale).translate([width / 2, height / 2]).clipAngle(90).precision(0.3);
    return d3.geoEqualEarth().rotate([rotation[0], 0]).scale(scale).translate([width / 2, height / 2 + flatTranslateY]).precision(0.3);
  }

  function resize() {
    document.body.classList.toggle('narrow', window.innerWidth < 640);
    const rect = $('mapwrap').getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = window.devicePixelRatio || 1;
    width = rect.width; height = rect.height;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    baseScale = mode === 'globe' ? Math.min(width, height) / 2 - 6 : width / 5.6;
    draw();
  }

  function valueOf(p) { return sizeBy === 'rate' ? p.per_1000_corpus_documents : p.documents; }
  function visiblePoints() { return sizeBy === 'rate' ? points.filter((p) => p.corpus_documents >= 20) : points; }

  function draw() {
    const proj = projection();
    const path = d3.geoPath(proj, ctx);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.beginPath(); path({ type: 'Sphere' }); ctx.fillStyle = css('--ocean'); ctx.fill();
    ctx.beginPath(); path(graticule); ctx.strokeStyle = css('--grid'); ctx.lineWidth = 0.7; ctx.stroke();
    ctx.beginPath(); path(land); ctx.fillStyle = css('--land'); ctx.fill();
    if (mode === 'globe') { ctx.beginPath(); path({ type: 'Sphere' }); ctx.strokeStyle = css('--line'); ctx.lineWidth = 1; ctx.stroke(); }

    const outline = data && data.region_outline;
    if (outline) {
      const shape = outline.type === 'circle'
        ? d3.geoCircle().center([outline.lon, outline.lat]).radius(outline.radius_km / 111.195).precision(2)()
        : boxPolygon(outline);
      ctx.beginPath(); path(shape); ctx.setLineDash([5, 4]); ctx.strokeStyle = css('--outline'); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }

    screen = [];
    const list = visiblePoints();
    const max = Math.max(1, ...list.map(valueOf));
    const center = [-rotation[0], -rotation[1]];
    const zoomBoost = Math.min(2, Math.max(1, Math.sqrt(scale / baseScale) * 0.8));
    const sorted = [...list].sort((a, b) => valueOf(b) - valueOf(a));
    for (const p of sorted) {
      if (mode === 'globe' && d3.geoDistance([p.lon, p.lat], center) > Math.PI / 2 - 0.01) continue;
      const xy = proj([p.lon, p.lat]);
      if (!xy || !isFinite(xy[0])) continue;
      const r = (2.5 + 15 * Math.sqrt(valueOf(p) / max)) * zoomBoost;
      screen.push({ p, x: xy[0], y: xy[1], r });
    }
    for (const s of screen) {
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 2 * Math.PI);
      ctx.fillStyle = css('--dot'); ctx.fill();
      ctx.lineWidth = s.p.searched && markSearched ? 2 : 0.8; ctx.strokeStyle = css('--dot-line'); ctx.stroke();
    }
    if (selected) {
      const s = screen.find((s) => s.p.id === selected.id);
      if (s) { ctx.beginPath(); ctx.arc(s.x, s.y, s.r + 4, 0, 2 * Math.PI); ctx.lineWidth = 2.5; ctx.strokeStyle = css('--sel'); ctx.stroke(); }
    }
    $('legend').textContent = sizeBy === 'rate'
      ? 'Size: matching documents per 1000 documents mentioning the place (places with < 20 such documents hidden)'
      : 'Size: matching documents mentioning the place' + (markSearched ? ' · thick ring / ●: a place you searched for' : '');
  }

  function boxPolygon(b) {
    const east = b.west <= b.east ? b.east : b.east + 360;
    const ring = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) ring.push([b.west + (east - b.west) * i / steps, b.south]);
    for (let i = 0; i <= steps; i++) ring.push([east, b.south + (b.north - b.south) * i / steps]);
    for (let i = steps; i >= 0; i--) ring.push([b.west + (east - b.west) * i / steps, b.north]);
    for (let i = steps; i >= 0; i--) ring.push([b.west, b.south + (b.north - b.south) * i / steps]);
    return { type: 'Polygon', coordinates: [ring.map(([x, y]) => [x > 180 ? x - 360 : x, y]).reverse()] };
  }

  function outlinePoints() {
    const o = data && data.region_outline;
    if (!o) return [];
    if (o.type === 'bbox') return [[o.west, o.south], [o.west, o.north], [o.east, o.south], [o.east, o.north]];
    const r = o.radius_km / 111.195;
    return [[o.lon, o.lat + r], [o.lon, o.lat - r], [o.lon + r / Math.cos(o.lat * Math.PI / 180), o.lat], [o.lon - r / Math.cos(o.lat * Math.PI / 180), o.lat]];
  }

  /** Rotate to the weighted centre of the places and zoom so that most of them fit. */
  function fit() {
    const list = points.length ? points : [];
    if (!list.length) { rotation = [-100, -5]; scale = baseScale; flatTranslateY = 0; return; }
    let x = 0, y = 0, z = 0;
    for (const p of list) {
      const w = Math.sqrt(p.documents), lon = p.lon * Math.PI / 180, lat = p.lat * Math.PI / 180;
      x += w * Math.cos(lat) * Math.cos(lon); y += w * Math.cos(lat) * Math.sin(lon); z += w * Math.sin(lat);
    }
    const lon = Math.atan2(y, x) * 180 / Math.PI;
    const lat = Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI;
    // Keep the region outline in view, and nearly all places (a few far outliers may fall outside).
    const distances = list.map((p) => d3.geoDistance([p.lon, p.lat], [lon, lat])).sort((a, b) => a - b);
    let spread = distances[Math.min(distances.length - 1, Math.floor(distances.length * 0.97))] || 0;
    for (const corner of outlinePoints()) spread = Math.max(spread, d3.geoDistance(corner, [lon, lat]));
    spread = Math.max(0.02, spread * 1.08);
    rotation = [-lon, mode === 'globe' ? -lat : 0];
    if (mode === 'globe') {
      scale = spread >= Math.PI / 2 ? baseScale : Math.min(baseScale * 40, Math.max(baseScale, (Math.min(width, height) * 0.42) / Math.sin(spread)));
      flatTranslateY = 0;
    } else {
      scale = Math.min(baseScale * 40, Math.max(baseScale, baseScale * (Math.PI / 2) / Math.max(spread, 0.05) / 1.6));
      const proj = d3.geoEqualEarth().rotate([rotation[0], 0]).scale(scale).translate([width / 2, height / 2]);
      const c = proj([lon, lat]);
      flatTranslateY = c ? height / 2 - c[1] : 0;
    }
  }

  // --- Interaction ----------------------------------------------------------------------------
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, r: [...rotation], t: flatTranslateY, moved: false }; canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging'); });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const k = 75 / scale * (mode === 'globe' ? 1 : 1.4);
      if (mode === 'globe') rotation = [drag.r[0] + dx * k, Math.max(-90, Math.min(90, drag.r[1] - dy * k))];
      else { rotation = [drag.r[0] + dx * k, 0]; flatTranslateY = drag.t + dy; }
      draw(); hideTip();
      return;
    }
    const hit = hitTest(e);
    canvas.style.cursor = hit ? 'pointer' : '';
    hit ? showTip(hit, e) : hideTip();
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('dragging');
    const wasDrag = drag && drag.moved;
    drag = null;
    if (wasDrag) return;
    const hit = hitTest(e);
    if (hit) select(hit.p);
  });
  canvas.addEventListener('pointerleave', hideTip);
  // Plain scrolling scrolls the chat; ctrl/⌘ + scroll (and trackpad pinch) zooms.
  canvas.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom(Math.exp(-e.deltaY * 0.01)); }, { passive: false });
  canvas.addEventListener('dblclick', () => zoom(1.8));

  function zoom(factor) { scale = Math.max(baseScale * 0.6, Math.min(baseScale * 60, scale * factor)); draw(); }
  function hitTest(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null;
    for (const s of screen) { const d = Math.hypot(s.x - x, s.y - y); if (d <= s.r + 3 && (!best || s.r < best.r)) best = s; }
    return best;
  }
  function showTip(hit, e) {
    const rect = $('mapwrap').getBoundingClientRect();
    const p = hit.p;
    $('tip').innerHTML = '';
    $('tip').append(el('b', p.label));
    if (p.also_recorded_as && p.also_recorded_as.length) $('tip').append(el('div', 'also: ' + p.also_recorded_as.join(', ')));
    $('tip').append(el('div', p.documents + ' matching documents'), el('div', p.per_1000_corpus_documents + ' per 1000 of its ' + p.corpus_documents + ' documents'));
    $('tip').style.display = 'block';
    $('tip').style.left = Math.min(rect.width - 200, e.clientX - rect.left + 12) + 'px';
    $('tip').style.top = (e.clientY - rect.top + 12) + 'px';
  }
  function hideTip() { $('tip').style.display = 'none'; }
  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }

  // --- Side panel -----------------------------------------------------------------------------
  function renderList() {
    const body = $('sidebody');
    body.className = '';
    body.textContent = '';
    $('side').querySelector('h2').textContent = 'Places, most matching documents first';
    const list = [...visiblePoints()].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 60);
    const max = Math.max(1, ...list.map(valueOf));
    for (const p of list) {
      const row = el('div', undefined, 'row');
      row.append(el('span', p.label + (p.searched && markSearched ? ' ●' : '')), el('span', sizeBy === 'rate' ? p.per_1000_corpus_documents + '‰' : String(p.documents), 'num'));
      const bar = el('div', undefined, 'bar'); bar.style.width = Math.max(2, 100 * valueOf(p) / max) + '%';
      row.append(bar);
      row.onclick = () => { select(p); centerOn(p); };
      body.append(row);
    }
    const missing = data.places_without_coordinates;
    if (missing && missing.total) {
      body.append(el('p', missing.total + ' mentioned place(s) have no coordinates and are not on the map: ' + missing.top.map((p) => p.label + ' (' + p.documents + ')').join(', ') + (missing.total > missing.top.length ? ', …' : ''), 'note'));
    }
    const off = data.matching_documents - data.documents_mentioning_a_mapped_place;
    if (off > 0) body.append(el('p', off + ' of ' + data.matching_documents + ' matching documents mention no linked place with coordinates; they are not on the map.', 'note'));
    if (data.places_with_coordinates > data.places_on_map) body.append(el('p', 'Showing the ' + data.places_on_map + ' most mentioned of ' + data.places_with_coordinates + ' places (max_places).', 'note'));
  }

  function centerOn(p) {
    if (mode === 'globe') rotation = [-p.lon, -p.lat];
    else rotation = [-p.lon, 0];
    draw();
  }

  async function select(p) {
    selected = p;
    draw();
    const body = $('sidebody');
    body.textContent = '';
    $('side').querySelector('h2').textContent = 'Place';
    const back = el('button', '← All places', 'link'); back.onclick = () => { selected = null; draw(); renderList(); };
    body.append(back, el('h3', p.label));
    if (p.also_recorded_as && p.also_recorded_as.length) body.append(el('div', 'Also recorded as: ' + p.also_recorded_as.join(', '), 'note'));
    body.append(el('div', p.id + (p.part_of && p.part_of.length ? ' · part of ' + p.part_of.join(', ') : ''), 'note'),
      el('div', p.documents + ' matching documents · ' + p.per_1000_corpus_documents + ' per 1000 of the ' + p.corpus_documents + ' documents that mention it'));
    const list = el('div', 'Loading documents…', 'note');
    body.append(list);
    reportSize();
    const filters = Object.assign({}, data.filters || {});
    filters.entities = [...(filters.entities || []), p.id].slice(0, 10);
    try {
      const result = await request('tools/call', { name: 'search_documents', arguments: { ...filters, page_size: 8, snippets_per_document: 1, snippet_format: 'plain', places_per_document: 0, count_mentions: false } });
      if (result && result.isError) throw { message: (result.content && result.content[0] && result.content[0].text) || 'error' };
      const text = (result.content || []).find((c) => c.type === 'text');
      const docs = JSON.parse(text.text);
      list.textContent = '';
      list.className = '';
      list.append(el('div', docs.total + ' documents; first ' + docs.results.length + ' by relevance:', 'note'));
      for (const d of docs.results) {
        const item = el('div', undefined, 'doc');
        item.append(el('div', d.title || d.document_id, 't'), el('div', [d.date, d.settlement, d.document_id].filter(Boolean).join(' · '), 'note'));
        if (d.snippets && d.snippets[0]) item.append(el('div', d.snippets[0], 's'));
        if (d.viewer_url) { const open = el('button', 'Open in Globalise viewer ↗', 'link'); open.onclick = () => openLink(d.viewer_url); item.append(open); }
        list.append(item);
      }
    } catch (error) {
      list.textContent = 'Could not load documents (' + (error && error.message || 'this client does not let the map call tools') + '). Ask in the chat for documents mentioning ' + p.label + ' (' + p.id + ').';
    }
    reportSize();
  }
  function openLink(url) { request('ui/open-link', { url }).catch(() => window.open(url, '_blank', 'noopener')); }

  // --- Loading a result -----------------------------------------------------------------------
  function parseResult(result) {
    if (result && result.structuredContent && result.structuredContent.kind === 'globalise-map') return result.structuredContent;
    const text = (result && result.content || []).find((c) => c.type === 'text');
    try { return text ? JSON.parse(text.text) : null; } catch (e) { diag('could not parse tool result: ' + e.message); return null; }
  }
  function load(result) {
    const parsed = parseResult(result);
    if (!parsed || parsed.kind !== 'globalise-map') { status('This tool result has no map data.', true); return; }
    data = parsed;
    points = (data.places || []).filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number');
    selected = null;
    markSearched = points.some((p) => p.searched) && !points.every((p) => p.searched);
    $('title').textContent = data.title || 'Places in the results';
    $('title').title = $('title').textContent;
    $('summary').textContent = data.matching_documents + ' documents · ' + points.length + ' places';
    resize(); fit(); draw(); renderList();
    const idx = data.provenance && data.provenance.index_versions ? ' · ' + data.provenance.index_versions.join(', ') : '';
    status('Places linked automatically in the transcriptions; counts are documents' + idx);
    reportSize();
  }

  // --- Controls -------------------------------------------------------------------------------
  const setMode = (m) => { mode = m; $('globe').setAttribute('aria-pressed', m === 'globe'); $('flat').setAttribute('aria-pressed', m === 'flat'); resize(); fit(); draw(); };
  const setSize = (s) => { sizeBy = s; $('bydocs').setAttribute('aria-pressed', s === 'documents'); $('byrate').setAttribute('aria-pressed', s === 'rate'); draw(); if (data && !selected) renderList(); };
  $('globe').onclick = () => setMode('globe');
  $('flat').onclick = () => setMode('flat');
  $('bydocs').onclick = () => setSize('documents');
  $('byrate').onclick = () => setSize('rate');
  $('zin').onclick = () => zoom(1.5);
  $('zout').onclick = () => zoom(1 / 1.5);
  $('zhome').onclick = () => { fit(); draw(); };
  $('details').onclick = () => { $('log').classList.toggle('open'); reportSize(); };
  $('expand').onclick = () => {
    const next = hostContext.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    request('ui/request-display-mode', { mode: next })
      .then((result) => applyHostContext({ ...hostContext, displayMode: (result && result.mode) || next }))
      .catch((error) => status('Could not change display mode: ' + (error && error.message), true));
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);

  resize(); draw();
  status('Connecting to the chat app…');
  request('ui/initialize', {
    appInfo: { name: 'globalise-map-viewer', version: '0.2.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    protocolVersion: PROTOCOL_VERSION,
  }).then((result) => {
    const host = result && result.hostInfo ? result.hostInfo.name + ' ' + (result.hostInfo.version || '') : 'host';
    diag('handshake ok with ' + host);
    notify('ui/notifications/initialized', {});
    applyHostContext((result && result.hostContext) || {});
    observer.observe(document.documentElement);
    observer.observe($('mapwrap'));
    reportSize();
    if (!data) status('Connected to ' + host + '. Waiting for the results…');
  }).catch((error) => status('Handshake with the chat app failed: ' + JSON.stringify(error), true));
})();
</script>
</body>
</html>`;
}
