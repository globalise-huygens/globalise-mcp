// MCP App (MCP Apps extension): an interactive scan viewer shown in the chat when get_scan runs,
// in clients that support MCP Apps (Claude, ChatGPT, VS Code).
//
// Framing the portal viewer (dev.globalise.nl) was tried first; Claude Desktop refuses nested
// frames, so this is a self-contained viewer: OpenSeadragon (inlined, same version as the portal)
// on the IIIF image, the transcription beside it, the quoted passage highlighted in both, and
// previous/next navigation through the document via get_scan.

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

function viewerHtml(openSeadragon: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GLOBALISE scan viewer</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1b; --muted: #6b6b66; --bg: #ffffff; --panel: #f7f6f2; --line: #e2e0da; --accent: #8a3b12; --mark: rgba(214, 120, 40, 0.28); }
  @media (prefers-color-scheme: dark) { :root { --fg: #ecebe6; --muted: #a3a29b; --bg: #1c1c1a; --panel: #242421; --line: #3a3935; --accent: #e8925f; --mark: rgba(232, 146, 95, 0.35); } }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, -apple-system, sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  .title { flex: 1 1 260px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
  .meta { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
  .controls { display: flex; gap: 4px; }
  button { font: inherit; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button:disabled { opacity: .4; cursor: default; }
  main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); height: 560px; }
  @media (max-width: 720px) { main { grid-template-columns: 1fr; grid-template-rows: 380px 260px; height: auto; } }
  #osd { position: relative; background: #2b2a27; min-height: 0; }
  #zoom { position: absolute; top: 8px; left: 8px; z-index: 5; display: flex; flex-direction: column; gap: 4px; }
  #zoom button { width: 30px; padding: 3px 0; background: rgba(255,255,255,.92); color: #1d1d1b; }
  #text { overflow: auto; padding: 10px 14px; border-left: 1px solid var(--line); background: var(--panel); white-space: pre-wrap; font: 13px/1.6 Georgia, serif; }
  #text h2 { font: 600 11px/1.2 system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; }
  mark { background: var(--mark); color: inherit; border-radius: 2px; }
  .highlight { border: 3px solid #e8925f; background: rgba(232, 146, 95, .12); border-radius: 3px; }
  footer { padding: 4px 12px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); display: flex; gap: 8px; }
  footer .warn { color: var(--accent); }
</style>
</head>
<body>
<header>
  <span class="title" id="title">Waiting for scan…</span>
  <span class="meta" id="scan"></span>
  <span class="controls">
    <button id="prev" title="Previous scan" disabled>‹</button>
    <span class="meta" id="pos"></span>
    <button id="next" title="Next scan" disabled>›</button>
  </span>
  <span class="controls">
    <button id="passage" hidden>Go to passage</button>
    <button id="open" hidden>Open in GLOBALISE</button>
  </span>
</header>
<main>
  <div id="osd"><div id="zoom"><button id="zin" title="Zoom in">+</button><button id="zout" title="Zoom out">−</button><button id="zhome" title="Fit page">⤢</button></div></div>
  <div id="text"><h2>Transcription (machine-generated)</h2><div id="body"></div></div>
</main>
<footer><span id="status">GLOBALISE scan viewer</span></footer>
<script>${openSeadragon}</script>
<script>
(() => {
  const PROTOCOL_VERSION = ${JSON.stringify(PROTOCOL_VERSION)};
  const $ = (id) => document.getElementById(id);
  let nextId = 1;
  const pending = new Map();
  let viewer = null;
  let current = null;
  let passageRect = null;

  // --- Host bridge (JSON-RPC over postMessage) --------------------------------------------
  const send = (msg) => window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject({ message: 'timeout' }); } }, 60000);
  });
  const notify = (method, params) => send({ method, params });
  const status = (text, warn) => { $('status').textContent = text; $('status').className = warn ? 'warn' : ''; };
  const reportSize = () => notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && !msg.method && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(msg.error) : resolve(msg.result);
    } else if (msg.method === 'ui/notifications/tool-result') {
      render(msg.params);
    } else if (msg.method === 'ui/resource-teardown' && msg.id !== undefined) {
      send({ id: msg.id, result: {} });
    } else if (msg.id !== undefined && msg.method) {
      send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  });

  document.addEventListener('securitypolicyviolation', (e) => status('Blocked by host policy: ' + e.violatedDirective + ' ' + (e.blockedURI || ''), true));

  // --- Rendering ------------------------------------------------------------------------------
  function parseResult(result) {
    if (result && result.structuredContent) return result.structuredContent;
    const text = (result && result.content || []).find((c) => c.type === 'text');
    try { return text ? JSON.parse(text.text) : null; } catch { return null; }
  }

  function render(result) {
    const data = parseResult(result);
    if (!data || !data.image || !data.image.iiif_service) { status('No scan in this tool result.', true); return; }
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

    renderText(data.text_normalized || data.text_diplomatic || '(no transcription on this page)', quote && quote.transcribed_as);
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
    if (!window.OpenSeadragon) { status('Viewer library failed to load.', true); return; }
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
    } else {
      viewer.open(infoUrl);
    }
  }

  function onOpen() {
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
  $('open').onclick = () => {
    if (!current || !current.viewer_url) return;
    request('ui/open-link', { url: current.viewer_url }).catch(() => window.open(current.viewer_url, '_blank', 'noopener'));
  };

  request('ui/initialize', {
    appInfo: { name: 'globalise-scan-viewer', version: '0.2.0' },
    appCapabilities: {},
    protocolVersion: PROTOCOL_VERSION,
  }).then(() => {
    notify('ui/notifications/initialized', {});
    status('Waiting for scan…');
    reportSize();
  }).catch((error) => status('Handshake with the host failed: ' + JSON.stringify(error), true));
})();
</script>
</body>
</html>`;
}
