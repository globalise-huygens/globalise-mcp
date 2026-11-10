// How GLOBALISE identifiers, persistent URIs, scans, manifests and portal links relate.
//
//   document  NL-HaNA_1.04.02_1968_0347-0350   a logical document spanning scans 0347..0350
//   scan      NL-HaNA_1.04.02_1968_0347        one page image (IIIF canvas) in inventory 1968
//   inventory 1968                             one archival volume = one IIIF manifest
//   person    Person_100901                    entity records (reference data)
//   place     GLOB2_937, GLOB_126, GLOB_RT_233
//   group     ORG_1                            organisations
//   polity    Polity_100
//   ship      gzm_ship0511                     ships; voyages are gzm_voyage0511
//   thesaurus 5b2cb1a2-fb88-...                SKOS concepts (professions, document types, ...)

import { config } from '../config.ts';

export type EntityKind =
  | 'document'
  | 'scan'
  | 'inventory'
  | 'person'
  | 'place'
  | 'group'
  | 'polity'
  | 'ship'
  | 'voyage'
  | 'thesaurus';

export interface ParsedId {
  kind: EntityKind;
  /** The local identifier, e.g. GLOB2_937. */
  id: string;
  /** The persistent URI, e.g. https://data.globalise.huygens.knaw.nl/hdl:20.500.14722/place:GLOB2_937 */
  uri: string;
}

const KINDS: EntityKind[] = ['document', 'scan', 'inventory', 'person', 'place', 'group', 'polity', 'ship', 'voyage', 'thesaurus'];
const SCAN_RE = /^(NL-HaNA_[\d.]+)_([^_]+)_(\d+)$/;
const DOCUMENT_RE = /^(NL-HaNA_[\d.]+)_([^_]+)_(\d+)-(\d+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uriFor = (kind: EntityKind, id: string): string => `${config.dataBase}/${kind === 'scan' ? 'canvas' : kind}:${id}`;

/** Recognises a bare id, a `kind:id` pair, or a full persistent URI. Returns null when unrecognised. */
export function parseId(input: string): ParsedId | null {
  let value = input.trim();
  if (!value) return null;

  // Full URI: .../hdl:20.500.14722/place:GLOB2_937 (optionally with .annotations, #fragment, etc.)
  const marker = '/hdl:20.500.14722/';
  const at = value.indexOf(marker);
  if (at >= 0) value = value.slice(at + marker.length);
  value = value.replace(/[#?].*$/, '').replace(/\.(annotations|manifest|json|txt)$/, '');

  const prefixed = /^([a-z]+):(.+)$/.exec(value);
  if (prefixed) {
    const prefix = prefixed[1] === 'canvas' ? 'scan' : prefixed[1] === 'organisation' ? 'group' : prefixed[1];
    const kind = KINDS.find((k) => k === prefix);
    if (kind) return { kind, id: prefixed[2], uri: uriFor(kind, prefixed[2]) };
    if (prefixed[1] === 'concept') return { kind: 'thesaurus', id: prefixed[2], uri: uriFor('thesaurus', prefixed[2]) };
  }

  const kind = guessKind(value);
  return kind ? { kind, id: value, uri: uriFor(kind, value) } : null;
}

function guessKind(id: string): EntityKind | null {
  if (DOCUMENT_RE.test(id)) return 'document';
  if (SCAN_RE.test(id)) return 'scan';
  if (/^Person_\w+$/i.test(id)) return 'person';
  if (/^GLOB[\w]*_\w+$/.test(id)) return 'place';
  if (/^ORG_\w+$/i.test(id)) return 'group';
  if (/^Polity_\w+$/i.test(id)) return 'polity';
  if (/ship\w*$/i.test(id) && /^gzm_ship/i.test(id)) return 'ship';
  if (/^gzm_voyage/i.test(id)) return 'voyage';
  if (UUID_RE.test(id)) return 'thesaurus';
  if (/^\d+[A-Za-z]?$/.test(id)) return 'inventory';
  return null;
}

export interface ScanRef {
  scanId: string;
  inventory: string;
  canvasUri: string;
  manifestUri: string;
}

export function scanRef(scanId: string): ScanRef | null {
  const match = SCAN_RE.exec(scanId);
  if (!match) return null;
  return {
    scanId,
    inventory: match[2],
    canvasUri: uriFor('scan', scanId),
    manifestUri: manifestUri(match[2]),
  };
}

export const manifestUri = (inventory: string): string => `${config.dataBase}/inventory:${inventory}.manifest`;

/** Every scan id of a document, e.g. NL-HaNA_1.04.02_1968_0347-0350 -> _0347, _0348, _0349, _0350. */
export function documentScanIds(documentId: string): string[] {
  const match = DOCUMENT_RE.exec(documentId);
  if (!match) return SCAN_RE.test(documentId) ? [documentId] : [];
  const [, archive, inventory, from, to] = match;
  const width = from.length;
  const start = Number(from);
  const end = Number(to);
  if (!(end >= start)) return [];
  const ids: string[] = [];
  for (let n = start; n <= end; n += 1) ids.push(`${archive}_${inventory}_${String(n).padStart(width, '0')}`);
  return ids;
}

/** Whether a scan falls inside a document's scan range, without expanding the range. */
export function documentContainsScan(documentId: string, scanId: string): boolean {
  const doc = DOCUMENT_RE.exec(documentId);
  const scan = SCAN_RE.exec(scanId);
  if (!doc || !scan || doc[1] !== scan[1] || doc[2] !== scan[2]) return false;
  const n = Number(scan[3]);
  return n >= Number(doc[3]) && n <= Number(doc[4]);
}

export function documentInventory(documentId: string): string | null {
  return DOCUMENT_RE.exec(documentId)?.[2] ?? SCAN_RE.exec(documentId)?.[2] ?? null;
}

/** Opens a scan in the GLOBALISE viewer (transcription next to the facsimile). */
export function viewerUrlForScan(scanId: string): string | null {
  const ref = scanRef(scanId);
  if (!ref) return null;
  const params = new URLSearchParams({ manifest: ref.manifestUri, canvas: ref.canvasUri });
  return `${config.portalBase}/manifest/?${params}`;
}

export function viewerUrlForDocument(documentId: string): string | null {
  const first = documentScanIds(documentId)[0];
  return first ? viewerUrlForScan(first) : null;
}

/** The portal's object card for any reference record (person, place, ship, concept, ...). */
export const objectCardUrl = (uri: string): string => `${config.portalBase}/object-card/?${new URLSearchParams({ uri })}`;

/** IIIF Image API URL for a scaled version or a region of an image service. */
export function iiifImageUrl(serviceId: string, options: { region?: string; width?: number } = {}): string {
  const region = options.region ?? 'full';
  const size = options.width ? `${options.width},` : 'max';
  return `${serviceId}/${region}/${size}/0/default.jpg`;
}
