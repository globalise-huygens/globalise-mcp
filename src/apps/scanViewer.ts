// MCP App (MCP Apps extension): an interactive scan viewer shown in the chat when get_scan runs,
// in clients that support MCP Apps (Claude, ChatGPT, VS Code).
//
// Framing the portal viewer (dev.globalise.nl) was tried first; Claude Desktop refuses nested
// frames, so this is a self-contained viewer: OpenSeadragon (inlined, same version as the portal)
// on the IIIF image, the transcription beside it, the quoted passage highlighted in both, and
// previous/next navigation through the document via get_scan.
//
// The host bridge follows @modelcontextprotocol/ext-apps (App class): ui/initialize handshake,
// ping, continuous size-changed notifications (width + height), host-context-changed handling.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SCAN_VIEWER_URI = 'ui://globalise/scan-viewer.html';
const MCP_APP_MIME = 'text/html;profile=mcp-app';
const PROTOCOL_VERSION = '2026-01-26';

/** Tool _meta that attaches the viewer (both current and legacy keys, for older hosts). */
export const scanViewerToolMeta = { ui: { resourceUri: SCAN_VIEWER_URI }, 'ui/resourceUri': SCAN_VIEWER_URI };

/** The IIIF image server of the Nationaal Archief: info.json via fetch, tiles as images. */
const IMAGE_ORIGIN = 'https://service.archief.nl';

const RESOURCE_META = {
  ui: {
    prefersBorder: true,
    csp: { connectDomains: [IMAGE_ORIGIN], resourceDomains: [IMAGE_ORIGIN] },
  },
};

let cachedHtml: string | null = null;

function openSeadragonSource(): string {
  const path = createRequire(import.meta.url).resolve('openseadragon/build/openseadragon/openseadragon.min.js');
  return readFileSync(path, 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '');
}

export function registerScanViewer(server: McpServer) {
  server.registerResource(
    'globalise-scan-viewer',
    SCAN_VIEWER_URI,
    { title: 'GLOBALISE scan viewer', mimeType: MCP_APP_MIME, _meta: RESOURCE_META },
    async (uri) => {
      cachedHtml ??= viewerHtml(openSeadragonSource());
      return { contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: cachedHtml, _meta: RESOURCE_META }] };
    },
  );
}

export function viewerHtml(openSeadragon: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GLOBALISE scan viewer</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1b; --muted: #6b6b66; --bg: #ffffff; --panel: #f7f6f2; --line: #e2e0da; --accent: #8a3b12; --mark: rgba(214, 120, 40, 0.28); --view-h: 520px; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ecebe6; --muted: #a3a29b; --bg: #1c1c1a; --panel: #242421; --line: #3a3935; --accent: #e8925f; --mark: rgba(232, 146, 95, 0.35); } }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, -apple-system, sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 8px 12px; }
  .title { flex: 1 1 240px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
  .meta { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
  .controls { display: flex; gap: 4px; align-items: center; }
  button { font: inherit; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button:disabled { opacity: .4; cursor: default; }
  #statusbar { display: flex; gap: 8px; align-items: baseline; padding: 3px 12px 6px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  #status { flex: 1; min-width: 0; }
  #status.warn { color: var(--accent); }
  #details { font-size: 11px; padding: 0 6px; }
  #log { display: none; margin: 0; padding: 6px 12px; border-bottom: 1px solid var(--line); font: 11px/1.4 ui-monospace, monospace; white-space: pre-wrap; color: var(--muted); max-height: 160px; overflow: auto; }
  #log.open { display: block; }
  main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); height: var(--view-h); }
  /* Fixed-height container or fullscreen: header on top, the viewer takes the rest. */
  body.fill { height: var(--fill-h); display: flex; flex-direction: column; overflow: hidden; }
  body.fill main { flex: 1 1 auto; height: auto; min-height: 0; }
  body.narrow main { grid-template-columns: 1fr; grid-template-rows: 60% 40%; }
  #osd { position: relative; background: #2b2a27; min-height: 0; min-width: 0; }
  #zoom { position: absolute; top: 8px; left: 8px; z-index: 5; display: flex; flex-direction: column; gap: 4px; }
  #zoom button { width: 30px; padding: 3px 0; background: rgba(255,255,255,.92); color: #1d1d1b; }
  #text { overflow: auto; padding: 10px 14px; border-left: 1px solid var(--line); background: var(--panel); white-space: pre-wrap; font: 13px/1.6 Georgia, serif; min-height: 0; }
  body.narrow #text { border-left: 0; border-top: 1px solid var(--line); }
  #text h2 { font: 600 11px/1.2 system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; }
  mark { background: var(--mark); color: inherit; border-radius: 2px; }
  .highlight { border: 3px solid #e8925f; background: rgba(232, 146, 95, .12); border-radius: 3px; pointer-events: none; }
</style>
</head>
<body>
<header>
  <span class="title" id="title">GLOBALISE scan viewer</span>
  <span class="meta" id="scan"></span>
  <span class="controls">
    <button id="prev" title="Previous scan" disabled>‹</button>
    <span class="meta" id="pos"></span>
    <button id="next" title="Next scan" disabled>›</button>
  </span>
  <span class="controls">
    <button id="passage" hidden>Go to passage</button>
    <button id="expand" hidden title="Show larger">Expand</button>
    <button id="open" hidden>Open in GLOBALISE</button>
  </span>
</header>
<div id="statusbar"><span id="status">Starting…</span><button id="details" title="Show diagnostics">details</button></div>
<pre id="log"></pre>
<main>
  <div id="osd"><div id="zoom"><button id="zin" title="Zoom in">+</button><button id="zout" title="Zoom out">−</button><button id="zhome" title="Fit page">⤢</button></div></div>
  <div id="text"><h2>Transcription (machine-generated)</h2><div id="body"></div></div>
</main>
<script>
// Diagnostics first, so that even a failure in the viewer library is reported.
window.__log = [];
window.__diag = function (line) {
  window.__log.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  var el = document.getElementById('log');
  if (el) el.textContent = window.__log.join('\\n');
};
window.addEventListener('error', function (e) { window.__diag('error: ' + e.message + (e.filename ? ' (' + e.filename.slice(-40) + ':' + e.lineno + ')' : '')); });
window.addEventListener('unhandledrejection', function (e) { window.__diag('unhandled rejection: ' + (e.reason && e.reason.message || e.reason)); });
document.addEventListener('securitypolicyviolation', function (e) { window.__diag('blocked by host CSP: ' + e.violatedDirective + ' ' + (e.blockedURI || '')); });
</script>
<script>${openSeadragon}</script>
<script>
(() => {
  const PROTOCOL_VERSION = ${JSON.stringify(PROTOCOL_VERSION)};
  const $ = (id) => document.getElementById(id);
  const diag = window.__diag;
  let nextId = 1;
  const pending = new Map();
  let viewer = null;
  let current = null;
  let passageRect = null;
  let hostContext = {};

  diag('script started; OpenSeadragon ' + (window.OpenSeadragon ? 'loaded (' + (OpenSeadragon.version && OpenSeadragon.version.versionStr) + ')' : 'NOT loaded'));

  // --- Host bridge (JSON-RPC 2.0 over postMessage, as in @modelcontextprotocol/ext-apps) ---------
  const send = (msg) => window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject({ message: method + ' timed out' }); } }, 60000);
  });
  const notify = (method, params) => send({ method, params });
  const status = (text, warn) => { $('status').textContent = text; $('status').className = warn ? 'warn' : ''; diag((warn ? 'WARN ' : '') + text); };

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
      case 'ping':
        send({ id: msg.id, result: {} });
        break;
      case 'ui/notifications/tool-input':
        if (msg.params && msg.params.arguments && msg.params.arguments.scan_id) $('scan').textContent = msg.params.arguments.scan_id;
        status('Loading scan…');
        break;
      case 'ui/notifications/tool-result':
        render(msg.params);
        break;
      case 'ui/notifications/host-context-changed':
        applyHostContext({ ...hostContext, ...(msg.params || {}) });
        break;
      case 'ui/notifications/tool-cancelled':
        status('The tool call was cancelled.', true);
        break;
      case 'ui/resource-teardown':
        send({ id: msg.id, result: {} });
        break;
      default:
        if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
    }
  });

  // --- Sizing: fit the host's container and report our size (width + height) -------------------
  function applyHostContext(context) {
    hostContext = context || {};
    const dims = hostContext.containerDimensions || {};
    const fixed = typeof dims.height === 'number' ? dims.height : null;
    const max = typeof dims.maxHeight === 'number' ? dims.maxHeight : null;
    const fullscreen = hostContext.displayMode === 'fullscreen';
    const root = document.documentElement;
    // Fill a fixed-height container (or the screen); otherwise use a comfortable height that
    // stays within the host's maximum.
    const fillHeight = fullscreen ? (fixed ? fixed + 'px' : '100vh') : fixed ? fixed + 'px' : null;
    document.body.classList.toggle('fill', !!fillHeight);
    if (fillHeight) root.style.setProperty('--fill-h', fillHeight);
    const chromeH = document.querySelector('header').offsetHeight + $('statusbar').offsetHeight;
    const viewH = max ? Math.max(240, Math.min(560, max - chromeH - 20)) : 560;
    root.style.setProperty('--view-h', viewH + 'px');
    const modes = hostContext.availableDisplayModes || [];
    $('expand').hidden = !modes.includes('fullscreen');
    $('expand').textContent = fullscreen ? 'Shrink' : 'Expand';
    diag('host context: mode=' + (hostContext.displayMode || '?') + ' modes=' + (modes.join('/') || '?') + ' container=' + JSON.stringify(dims) + (fillHeight ? ' → fill ' + fillHeight : ' → view ' + viewH + 'px'));
    layout();
  }

  function layout() {
    document.body.classList.toggle('narrow', window.innerWidth < 640);
    if (viewer) viewer.forceResize && viewer.forceResize();
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
      if (width !== lastW || height !== lastH) {
        lastW = width; lastH = height;
        notify('ui/notifications/size-changed', { width, height });
      }
    });
  }
  const observer = new ResizeObserver(() => { layout(); reportSize(); });

  // --- Rendering ------------------------------------------------------------------------------
  function parseResult(result) {
    if (result && result.structuredContent && result.structuredContent.scan_id) return result.structuredContent;
    const text = (result && result.content || []).find((c) => c.type === 'text');
    try { return text ? JSON.parse(text.text) : null; } catch (e) { diag('could not parse tool result: ' + e.message); return null; }
  }

  function render(result) {
    const data = parseResult(result);
    diag('tool result: ' + (data ? 'scan ' + data.scan_id + ', image ' + (data.image ? 'yes' : 'no') + ', text ' + (data.text_normalized || data.text_diplomatic ? 'yes' : 'no') : 'unreadable'));
    if (!data || !data.image || !data.image.iiif_service) { status('This tool result has no scan image.', true); return; }
    current = data;
    const nav = data.navigation || {};
    $('title').textContent = (data.document && data.document.title) || 'Scan';
    $('title').title = $('title').textContent;
    $('scan').textContent = data.scan_id || '';
    $('pos').textContent = nav.position_in_document ? nav.position_in_document + '/' + nav.scans_in_document : '';
    $('prev').disabled = !nav.previous_scan;
    $('next').disabled = !nav.next_scan;
    $('open').hidden = !data.viewer_url;

    const quote = data.quote_location && data.quote_location.found ? data.quote_location : null;
    passageRect = quote ? quote.iiif_region.split(',').map(Number) : null;
    $('passage').hidden = !passageRect;

    renderText(data.text_normalized || data.text_diplomatic || '(No transcription returned for this page.)', quote && quote.transcribed_as);
    openImage(data.image.iiif_service + '/info.json');
    status('Scan ' + data.scan_id + ' · image: Nationaal Archief (IIIF) · text: GLOBALISE HTR');
    reportSize();
  }

  function renderText(text, passage) {
    const body = $('body');
    body.textContent = '';
    if (!passage) { body.textContent = text.trim(); return; }
    const words = passage.split(/\\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'));
    const match = words.length ? new RegExp(words.join('\\\\s+'), 'i').exec(text) : null;
    if (!match) { body.textContent = text.trim(); return; }
    body.append(text.slice(0, match.index).replace(/^\\s+/, ''));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    body.append(mark, text.slice(match.index + match[0].length).replace(/\\s+$/, ''));
    requestAnimationFrame(() => mark.scrollIntoView({ block: 'center' }));
  }

  function openImage(infoUrl) {
    if (!window.OpenSeadragon) { status('The image viewer library did not load; see details.', true); return; }
    diag('opening image ' + infoUrl);
    try {
      if (!viewer) {
        viewer = OpenSeadragon({
          element: $('osd'),
          tileSources: infoUrl,
          showNavigationControl: false,
          crossOriginPolicy: 'Anonymous',
          visibilityRatio: 0.5,
          minZoomImageRatio: 0.5,
          maxZoomPixelRatio: 3,
          // Scrolling should scroll the chat, not zoom the scan.
          gestureSettingsMouse: { scrollToZoom: false, clickToZoom: false, dblClickToZoom: true },
        });
        viewer.addHandler('open', onOpen);
        viewer.addHandler('open-failed', (e) => status('Could not open the image: ' + (e.message || 'unknown error'), true));
        viewer.addHandler('tile-load-failed', (e) => diag('tile failed: ' + (e.message || (e.tile && e.tile.getUrl && e.tile.getUrl()) || '?')));
      } else {
        viewer.open(infoUrl);
      }
    } catch (error) {
      status('The image viewer failed: ' + error.message, true);
    }
  }

  function onOpen() {
    diag('image opened');
    viewer.clearOverlays();
    if (!passageRect) return;
    const el = document.createElement('div');
    el.className = 'highlight';
    const rect = viewer.viewport.imageToViewportRectangle(passageRect[0], passageRect[1], passageRect[2], passageRect[3]);
    viewer.addOverlay({ element: el, location: rect });
    goToPassage(true);
  }

  function goToPassage(immediately) {
    if (!viewer || !passageRect) return;
    const [x, y, w, h] = passageRect;
    const pad = Math.max(w, h) * 0.6;
    const rect = viewer.viewport.imageToViewportRectangle(x - pad, y - pad * 1.5, w + pad * 2, h + pad * 3);
    viewer.viewport.fitBounds(rect, immediately);
  }

  async function navigate(scanId) {
    if (!scanId) return;
    status('Loading ' + scanId + '…');
    try {
      const result = await request('tools/call', { name: 'get_scan', arguments: { scan_id: scanId, text: 'normalized', annotations: false } });
      if (result && result.isError) throw { message: (result.content && result.content[0] && result.content[0].text) || 'error' };
      render(result);
    } catch (error) {
      status('Could not load ' + scanId + ': ' + (error && error.message || 'this client does not let the viewer call tools') + '. Use "Open in GLOBALISE" instead.', true);
    }
  }

  // --- Controls -------------------------------------------------------------------------------
  $('zin').onclick = () => viewer && viewer.viewport.zoomBy(1.5);
  $('zout').onclick = () => viewer && viewer.viewport.zoomBy(1 / 1.5);
  $('zhome').onclick = () => viewer && viewer.viewport.goHome();
  $('passage').onclick = () => goToPassage(false);
  $('prev').onclick = () => navigate(current && current.navigation && current.navigation.previous_scan);
  $('next').onclick = () => navigate(current && current.navigation && current.navigation.next_scan);
  $('details').onclick = () => { $('log').classList.toggle('open'); applyHostContext(hostContext); reportSize(); };
  $('open').onclick = () => {
    if (!current || !current.viewer_url) return;
    request('ui/open-link', { url: current.viewer_url }).catch(() => window.open(current.viewer_url, '_blank', 'noopener'));
  };
  $('expand').onclick = () => {
    const mode = hostContext.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    request('ui/request-display-mode', { mode })
      .then((result) => applyHostContext({ ...hostContext, displayMode: (result && result.mode) || mode }))
      .catch((error) => status('Could not change display mode: ' + (error && error.message), true));
  };

  status('Connecting to the chat app…');
  request('ui/initialize', {
    appInfo: { name: 'globalise-scan-viewer', version: '0.3.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    protocolVersion: PROTOCOL_VERSION,
  }).then((result) => {
    const host = result && result.hostInfo ? result.hostInfo.name + ' ' + (result.hostInfo.version || '') : 'host';
    diag('handshake ok with ' + host + ', protocol ' + (result && result.protocolVersion));
    notify('ui/notifications/initialized', {});
    applyHostContext((result && result.hostContext) || {});
    observer.observe(document.documentElement);
    observer.observe(document.body);
    reportSize();
    if (!current) status('Connected to ' + host + '. Waiting for the scan…');
  }).catch((error) => status('Handshake with the chat app failed: ' + JSON.stringify(error), true));
})();
</script>
</body>
</html>`;
}
