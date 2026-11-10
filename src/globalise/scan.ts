// Scan-level ground truth: the page image (IIIF), the page transcription (normalised and
// diplomatic HTR text), and the entity/event annotations the NLP pipeline made on that page.

import { config } from '../config.ts';
import { fetchJson, withUpstreamSlot } from '../util/http.ts';
import { iiifImageUrl, scanRef, viewerUrlForScan, type ScanRef } from './ids.ts';
import { labelOf } from './linkedart.ts';

type Obj = Record<string, any>;
const asArray = <T>(v: T | T[] | null | undefined): T[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

export interface ScanImage {
  width: number;
  height: number;
  /** IIIF Image API service base; append /region/size/rotation/quality.format */
  service: string;
  full: string;
  preview: string;
}

/** Looks up a scan's image in its inventory manifest (manifests are cached; one per inventory). */
export async function scanImage(ref: ScanRef): Promise<ScanImage | null> {
  const manifest = await fetchJson<Obj>(ref.manifestUri);
  const canvas = asArray<Obj>(manifest.items).find((item) => item?.id === ref.canvasUri);
  const body = canvas?.items?.[0]?.items?.[0]?.body;
  const service = asArray<Obj>(body?.service)[0]?.id ?? asArray<Obj>(body?.service)[0]?.['@id'];
  if (!service) return null;
  return {
    width: Number(canvas?.width ?? body?.width ?? 0),
    height: Number(canvas?.height ?? body?.height ?? 0),
    service,
    full: iiifImageUrl(service),
    preview: iiifImageUrl(service, { width: 1200 }),
  };
}

/** The title/date ranges (table of contents) of an inventory, as listed in its manifest. */
export async function inventoryInfo(inventory: string): Promise<{ label: string | null; scanCount: number; metadata: Record<string, string> }> {
  const manifest = await fetchJson<Obj>(`${config.dataBase}/inventory:${inventory}.manifest`);
  const metadata: Record<string, string> = {};
  for (const entry of asArray<Obj>(manifest.metadata)) {
    const key = firstLang(entry.label);
    const value = firstLang(entry.value);
    if (key && value) metadata[key] = value;
  }
  return { label: firstLang(manifest.label), scanCount: asArray(manifest.items).length, metadata };
}

function firstLang(value: any): string | null {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value : null;
  const list = Object.values(value).flat();
  return list.length ? list.map(String).join('; ') : null;
}

interface Word {
  text: string;
  box: [number, number, number, number]; // x, y, w, h
  order: number;
}

export interface ScanTranscription {
  normalized: string | null;
  diplomatic: string | null;
  words: Word[];
}

export async function scanTranscription(scanId: string): Promise<ScanTranscription> {
  const page = await fetchJson<Obj>(`${config.dataBase}/annotations:transcriptions:${scanId}`);
  const items = asArray<Obj>(page.items);
  const pageText = (suffix: string) => {
    const anno = items.find((a) => a.textGranularity === 'page' && String(a.id).endsWith(suffix));
    return asArray<Obj>(anno?.body).find((b) => typeof b?.value === 'string')?.value ?? null;
  };
  const words: Word[] = [];
  for (const anno of items) {
    if (anno.textGranularity !== 'word') continue;
    const text = asArray<Obj>(anno.body).find((b) => typeof b?.value === 'string')?.value;
    const targets = asArray<Obj>(anno.target);
    const svg = targets.find((t) => t?.selector?.type === 'SvgSelector')?.selector?.value;
    const position = targets.flatMap((t) => asArray<Obj>(t?.selector)).find((s) => s?.type === 'TextPositionSelector');
    const box = svg ? boundingBox(svg) : null;
    if (text && box) words.push({ text, box, order: Number(position?.start ?? words.length) });
  }
  words.sort((a, b) => a.order - b.order);
  return { normalized: pageText('#page-normalized'), diplomatic: pageText('#page-htr'), words };
}

function boundingBox(svg: string): [number, number, number, number] | null {
  const numbers = [...svg.matchAll(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (!numbers.length) return null;
  const xs = numbers.map((p) => p[0]);
  const ys = numbers.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

const normaliseWord = (w: string) => w.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Finds a quoted passage among the page's words and returns the IIIF region around it.
 * Tolerant of HTR noise: the best window with at least half of the quote's words matching wins.
 */
export function locateQuote(words: Word[], quote: string, padding = 60): { region: string; matchedWords: number; quoteWords: number; matchedText: string } | null {
  const target = quote.split(/\s+/).map(normaliseWord).filter(Boolean);
  if (!target.length || !words.length) return null;
  const normalised = words.map((w) => normaliseWord(w.text));
  let best = { start: -1, end: -1, score: 0 };
  for (let start = 0; start < normalised.length; start += 1) {
    if (normalised[start] !== target[0] && normalised[start] !== target[1]) continue;
    let score = 0;
    let t = 0;
    let i = start;
    // Greedy alignment allowing one skipped word on either side per step.
    while (i < normalised.length && t < target.length) {
      if (normalised[i] === target[t]) {
        score += 1;
        i += 1;
        t += 1;
      } else if (normalised[i + 1] === target[t]) i += 1;
      else t += 1;
    }
    if (score > best.score) best = { start, end: i - 1, score };
  }
  if (best.start < 0 || best.score < Math.max(1, Math.ceil(target.length / 2))) return null;
  const span = words.slice(best.start, best.end + 1);
  const x0 = Math.min(...span.map((w) => w.box[0])) - padding;
  const y0 = Math.min(...span.map((w) => w.box[1])) - padding;
  const x1 = Math.max(...span.map((w) => w.box[0] + w.box[2])) + padding;
  const y1 = Math.max(...span.map((w) => w.box[1] + w.box[3])) + padding;
  const x = Math.max(0, Math.round(x0));
  const y = Math.max(0, Math.round(y0));
  return {
    region: `${x},${y},${Math.round(x1 - x)},${Math.round(y1 - y)}`,
    matchedWords: best.score,
    quoteWords: target.length,
    matchedText: span.map((w) => w.text).join(' '),
  };
}

export interface PageAnnotation {
  kind: 'entity' | 'event';
  type: string;
  label: string | null;
  classification: string | null;
  quote: string | null;
  /** Linked records (places, concepts, ...) mentioned in the annotation body. */
  links: string[];
  /** IIIF URL of the region on the scan, when the annotation has one. */
  region: string | null;
}

/** Entity and event annotations on one scan, flattened. */
export async function scanAnnotations(scanId: string): Promise<PageAnnotation[]> {
  const load = (kind: 'entities' | 'events') =>
    fetchJson<Obj>(`${config.dataBase}/annotations:${kind}:${scanId}`).catch(() => ({ items: [] }) as Obj);
  const [entities, events] = await Promise.all([load('entities'), load('events')]);
  const flatten = (page: Obj, kind: PageAnnotation['kind']): PageAnnotation[] =>
    asArray<Obj>(page.items).map((anno) => {
      const body = asArray<Obj>(anno.body)[0] ?? {};
      const subject = body.has_classificatory_subject ?? body;
      const targets = asArray<Obj>(anno.target);
      const quote = targets.flatMap((t) => asArray<Obj>(t?.selector)).find((s) => s?.type === 'TextQuoteSelector')?.exact ?? null;
      const region = targets.find((t) => t?.type === 'DigitalObject' && typeof t.id === 'string' && !t.id.includes('/full/'))?.id ?? null;
      return {
        kind,
        type: String(asArray(subject.type)[0] ?? asArray(body.type)[0] ?? ''),
        label: body.label ?? labelOf(body) ?? null,
        classification: labelOf(body.classified_as) ?? null,
        quote,
        links: collectUris(body),
        region,
      };
    });
  return [...flatten(entities, 'entity'), ...flatten(events, 'event')];
}

function collectUris(node: unknown, out = new Set<string>(), depth = 0): string[] {
  if (depth > 8 || !node || typeof node !== 'object') return [...out];
  if (Array.isArray(node)) node.forEach((n) => collectUris(n, out, depth + 1));
  else {
    const id = (node as Obj).id;
    if (typeof id === 'string' && id.startsWith(config.dataBase) && !id.includes('/annotations:') && !id.includes('/type:')) out.add(id);
    Object.values(node as Obj).forEach((v) => collectUris(v, out, depth + 1));
  }
  return [...out];
}

export function scanLinks(scanId: string) {
  const ref = scanRef(scanId);
  return ref ? { ref, viewer: viewerUrlForScan(scanId) } : null;
}

/** Downloads a (scaled) scan image for multimodal models. */
export function fetchImageBase64(url: string): Promise<{ data: string; mimeType: string; bytes: number }> {
  return withUpstreamSlot(async () => {
    const response = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(config.requestTimeoutMs) });
    if (!response.ok) throw new Error(`Image request failed: ${response.status} ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { data: buffer.toString('base64'), mimeType: response.headers.get('content-type')?.split(';')[0] || 'image/jpeg', bytes: buffer.length };
  });
}
