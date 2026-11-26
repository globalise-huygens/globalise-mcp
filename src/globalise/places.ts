// Places and how they relate: coordinates, "part of" hierarchy and overlapping places, from the
// place-objects index, held in memory as one graph (the index is small: a few thousand records).
//
//   place-objects fields used here
//     geoPoint            one point per place (no boundaries)
//     placeHierarchy      direct parents ("part of"), e.g. Calicut → Kerala
//     place               every related place: the parents plus places that overlap this one
//                         (same name, other sense: the city, the kingdom and the Company settlement
//                         of Kozhikode are three records that overlap)
//     placeClassification thesaurus concepts (city, island, kingdom, fort, region, ...)
//
// Some parents have no record in the index (modern administrative regions, NEW_ADMIN_…, and a
// few others); they are only known by their linked-data label. The text links mentions to place
// ids (placeId:<id>), but only to some kinds of record: regions are matched by expanding them to
// the ids of the places they contain and keeping those that occur in the text.

import { config } from '../config.ts';
import { LruCache } from '../util/cache.ts';
import { fetchJson } from '../util/http.ts';
import { esSearch, splitTitles } from './es.ts';
import { parseId, uriFor } from './ids.ts';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface PlaceNode {
  id: string;
  /** All recorded spellings; the first is the display label. */
  names: string[];
  label: string;
  point: GeoPoint | null;
  /** Thesaurus concept ids (city, island, kingdom, ...). */
  classifications: string[];
  /** Direct "part of" parents. */
  parents: string[];
  /** Direct children: places recorded as part of this one. */
  children: string[];
  /** Places that overlap this one (other senses of the same name, both directions). */
  overlaps: string[];
  /** Whether the place has its own record in place-objects (false: only known as a parent). */
  indexed: boolean;
  /** Documents whose text links a mention to this place id. */
  documents: number;
}

export interface PlaceGraph {
  nodes: Map<string, PlaceNode>;
  indexVersion: string;
  loadedAt: string;
}

export interface PlaceSource {
  title?: unknown;
  place?: string[];
  placeHierarchy?: string[];
  geoPoint?: { lat: number; lon: number } | null;
  placeClassification?: string[];
}

/** place:<id> at the end of a URI (id.globalise.nl or data.globalise…), or the input unchanged. */
export const placeIdOf = (uri: string): string => /place:([^/#?]+)$/.exec(uri)?.[1] ?? uri;

const conceptIdOf = (uri: string): string => /thesaurus:([^/#?]+)$/.exec(uri)?.[1] ?? uri;

/** Builds the graph from index records. Pure: labels of unindexed parents and counts are passed in. */
export function buildPlaceGraph(
  records: Array<{ id: string; source: PlaceSource }>,
  options: { labels?: Map<string, string>; documents?: Map<string, number>; indexVersion?: string } = {},
): PlaceGraph {
  const nodes = new Map<string, PlaceNode>();
  const node = (id: string): PlaceNode => {
    let n = nodes.get(id);
    if (!n) {
      const label = options.labels?.get(id) ?? id;
      n = { id, names: [label], label, point: null, classifications: [], parents: [], children: [], overlaps: [], indexed: false, documents: 0 };
      nodes.set(id, n);
    }
    return n;
  };

  for (const { id, source } of records) {
    const n = node(id);
    const names = splitTitles(source.title);
    n.indexed = true;
    n.names = names.length ? names : [id];
    n.label = n.names[0];
    const point = source.geoPoint;
    n.point = point && Number.isFinite(point.lat) && Number.isFinite(point.lon) ? { lat: point.lat, lon: point.lon } : null;
    n.classifications = (source.placeClassification ?? []).map(conceptIdOf);
    n.parents = [...new Set((source.placeHierarchy ?? []).map(placeIdOf))].filter((p) => p !== id);
  }

  for (const { id, source } of records) {
    const n = nodes.get(id)!;
    for (const parent of n.parents) {
      const p = node(parent);
      if (!p.children.includes(id)) p.children.push(id);
    }
    for (const related of (source.place ?? []).map(placeIdOf)) {
      if (related === id || n.parents.includes(related)) continue;
      const r = node(related);
      if (!n.overlaps.includes(related)) n.overlaps.push(related);
      if (!r.overlaps.includes(id) && !r.parents.includes(id)) r.overlaps.push(id);
    }
  }

  for (const [id, count] of options.documents ?? []) {
    const n = nodes.get(id);
    if (n) n.documents = count;
  }
  return { nodes, indexVersion: options.indexVersion ?? 'place-objects', loadedAt: new Date().toISOString() };
}

// --- Loading ------------------------------------------------------------------------------

const graphCache = new LruCache<PlaceGraph>(1, 6 * 60 * 60_000);

/** The whole place graph, with document counts per place. Loaded once and cached for hours. */
export function placeGraph(): Promise<PlaceGraph> {
  return graphCache.getOrCompute('graph', loadPlaceGraph);
}

async function loadPlaceGraph(): Promise<PlaceGraph> {
  const records: Array<{ id: string; source: PlaceSource }> = [];
  let indexVersion = 'place-objects';
  let after: unknown[] | undefined;
  for (let page = 0; page < 20; page += 1) {
    const data = await esSearch<PlaceSource>('places', {
      size: 5000,
      _source: ['title', 'place', 'placeHierarchy', 'geoPoint', 'placeClassification'],
      query: { match_all: {} },
      sort: [{ id: 'asc' }],
      ...(after ? { search_after: after } : {}),
    });
    const hits = data.hits.hits;
    if (hits[0]) indexVersion = hits[0]._index;
    for (const hit of hits) records.push({ id: hit._id, source: hit._source });
    if (hits.length < 5000) break;
    after = (hits.at(-1) as unknown as { sort: unknown[] }).sort;
  }

  // Parents without a record of their own: take their label from the linked-data record.
  const known = new Set(records.map((r) => r.id));
  const unindexed = [...new Set(records.flatMap((r) => (r.source.placeHierarchy ?? []).concat(r.source.place ?? []).map(placeIdOf)))].filter((id) => !known.has(id));
  const labels = new Map<string, string>();
  await Promise.all(
    unindexed.map(async (id) => {
      try {
        const record = await fetchJson<{ _label?: unknown }>(uriFor('place', id), { noCache: true });
        if (typeof record._label === 'string' && record._label) labels.set(id, record._label);
      } catch {
        // Keep the id as label.
      }
    }),
  );

  const documents = await documentCounts(records.map((r) => r.id));
  return buildPlaceGraph(records, { labels, documents, indexVersion });
}

/** Documents linking each id, in batches of one filters aggregation each. */
async function documentCounts(ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 1000) batches.push(ids.slice(i, i + 1000));
  await Promise.all(
    batches.map(async (batch) => {
      const data = await esSearch('documents', {
        size: 0,
        query: { match_all: {} },
        aggs: { places: { filters: { filters: Object.fromEntries(batch.map((id) => [id, placeTerm(id)])) } } },
      });
      for (const [id, bucket] of Object.entries<any>(data.aggregations?.places?.buckets ?? {})) counts.set(id, bucket.doc_count ?? 0);
    }),
  );
  return counts;
}

export const placeTerm = (id: string) => ({ term: { annotatedText: `placeId:${id}` } });

/** Documents mentioning any of these places. */
export const anyPlaceClause = (ids: string[]) => (ids.length ? { terms: { annotatedText: ids.map((id) => `placeId:${id}`) } } : { match_none: {} });

/** Span version of anyPlaceClause, for proximity searches. */
export function anyPlaceSpan(ids: string[]): Record<string, unknown> | null {
  if (!ids.length) return null;
  const spans = ids.map((id) => ({ span_term: { annotatedText: `placeId:${id}` } }));
  return spans.length === 1 ? spans[0] : { span_or: { clauses: spans } };
}

/** Largest region that may be used inside a proximity group (one span clause per place). */
export const MAX_SPAN_PLACES = 1000;

// --- Geometry -----------------------------------------------------------------------------

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Inside the box; west > east means the box crosses the 180° meridian. */
export function inBox(point: GeoPoint, box: BoundingBox): boolean {
  if (point.lat < box.south || point.lat > box.north) return false;
  return box.west <= box.east ? point.lon >= box.west && point.lon <= box.east : point.lon >= box.west || point.lon <= box.east;
}

// --- Finding places -----------------------------------------------------------------------

export const normaliseName = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Places with a spelling equal to the name (accents and punctuation ignored), best first. */
export function placesNamed(graph: PlaceGraph, name: string): PlaceNode[] {
  const key = normaliseName(name);
  if (!key) return [];
  const exact = [...graph.nodes.values()].filter((n) => n.names.some((s) => normaliseName(s) === key));
  return exact.sort(byImportance);
}

/** Places with a spelling containing the text as a word prefix, best first. */
export function placesMatching(graph: PlaceGraph, text: string, limit = 25): PlaceNode[] {
  const key = normaliseName(text.replace(/[*?]/g, ''));
  if (!key) return [];
  const pattern = new RegExp(`(^| )${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return [...graph.nodes.values()].filter((n) => n.names.some((s) => pattern.test(normaliseName(s)))).sort(byImportance).slice(0, limit);
}

/** Regions with many sub-places first, then places with many documents. */
const byImportance = (a: PlaceNode, b: PlaceNode) => b.children.length - a.children.length || b.documents - a.documents || a.label.localeCompare(b.label);

export interface ResolvedPlace {
  node: PlaceNode;
  /** Other places with the same name, when the input was a name. */
  alternatives: PlaceNode[];
  method: string;
}

/** A place id, URI or name → a place in the graph. Throws with a helpful message when unknown. */
export function resolvePlace(graph: PlaceGraph, input: string): ResolvedPlace {
  const value = input.trim();
  const parsed = parseId(value);
  const id = parsed?.kind === 'place' ? parsed.id : placeIdOf(value);
  const direct = graph.nodes.get(id);
  if (direct) return { node: direct, alternatives: [], method: 'place id' };
  if (parsed?.kind === 'place') throw new Error(`Place ${parsed.id} is not in the place index (${graph.indexVersion}). Use search_reference_data or explore_places to find a place id.`);

  const named = placesNamed(graph, value);
  if (named.length) {
    // Other senses of the same place (overlapping records) are not real alternatives.
    const alternatives = named.slice(1).filter((n) => !named[0].overlaps.includes(n.id) && !n.overlaps.includes(named[0].id));
    return {
      node: named[0],
      alternatives: alternatives.slice(0, 5),
      method: alternatives.length ? `name "${value}": ${alternatives.length + 1} different places have this spelling; took the one with most sub-places/documents` : `name "${value}"`,
    };
  }
  const similar = placesMatching(graph, value, 5);
  const hint = similar.length ? ` Similar: ${similar.map((n) => `${n.label} (${n.id})`).join(', ')}.` : '';
  throw new Error(`No place named "${value}".${hint} Use search_reference_data or explore_places to find the place id.`);
}

/** "lat,lon" → a point, or null. */
export function parsePoint(input: string): GeoPoint | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(input);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// --- Relations ----------------------------------------------------------------------------

/** Every place contained in a place: children, their children, ..., and (optionally) the places overlapping each. */
export function containedPlaces(graph: PlaceGraph, root: string, followOverlaps = true): { members: Set<string>; overlapsFollowed: Array<[string, string]> } {
  const members = new Set([root]);
  const overlapsFollowed: Array<[string, string]> = [];
  const queue = [root];
  while (queue.length) {
    const id = queue.shift()!;
    const n = graph.nodes.get(id);
    if (!n) continue;
    for (const child of n.children) {
      if (!members.has(child)) {
        members.add(child);
        queue.push(child);
      }
    }
    if (!followOverlaps) continue;
    for (const other of n.overlaps) {
      if (!members.has(other)) {
        members.add(other);
        queue.push(other);
        overlapsFollowed.push([id, other]);
      }
    }
  }
  return { members, overlapsFollowed };
}

/** Chains from a place up its "part of" hierarchy, e.g. ["Calechut", "Kerala"]; also from its overlapping places. */
export function broaderChains(graph: PlaceGraph, id: string, limit = 12): Array<{ from: string; chain: PlaceNode[] }> {
  const start = graph.nodes.get(id);
  if (!start) return [];
  const chains: Array<{ from: string; chain: PlaceNode[] }> = [];
  const walk = (from: string, node: PlaceNode, path: PlaceNode[]) => {
    if (chains.length >= limit) return;
    const parents = node.parents.map((p) => graph.nodes.get(p)).filter((p): p is PlaceNode => !!p && !path.includes(p));
    if (!parents.length) {
      if (path.length > 1) chains.push({ from, chain: path });
      return;
    }
    for (const parent of parents) walk(from, parent, [...path, parent]);
  };
  walk(id, start, [start]);
  for (const other of start.overlaps) {
    const node = graph.nodes.get(other);
    if (node) walk(other, node, [node]);
  }
  return chains;
}

export function nearbyPlaces(graph: PlaceGraph, center: GeoPoint, radiusKm: number, exclude?: string): Array<{ node: PlaceNode; km: number }> {
  const out: Array<{ node: PlaceNode; km: number }> = [];
  for (const node of graph.nodes.values()) {
    if (!node.point || node.id === exclude) continue;
    const km = distanceKm(center, node.point);
    if (km <= radiusKm) out.push({ node, km: Math.round(km * 10) / 10 });
  }
  return out.sort((a, b) => a.km - b.km);
}

// --- Regions ------------------------------------------------------------------------------

export interface RegionSpec {
  /** A place (id or name) whose contained places form the region. */
  within?: string;
  /** A box in decimal degrees. */
  bbox?: BoundingBox;
  /** A centre: place id/name or "lat,lon". */
  near?: string;
  radius_km?: number;
  /** Also take in places that overlap the places found (other senses of the same name). Default true. */
  follow_overlaps?: boolean;
}

export interface ResolvedRegion {
  description: string;
  /** Every place in the region. */
  members: PlaceNode[];
  /** Members that the text links mentions to, most documents first. These are what document searches match. */
  linked: PlaceNode[];
  overlapsFollowed: Array<{ from: string; to: string }>;
  notes: string[];
}

export const DEFAULT_RADIUS_KM = 25;

export function hasRegion(spec: RegionSpec | undefined): spec is RegionSpec {
  return !!spec && !!(spec.within || spec.bbox || spec.near);
}

/** The places in a region. Several criteria together are intersected. Pure. */
export function regionOf(graph: PlaceGraph, spec: RegionSpec): ResolvedRegion {
  if (!hasRegion(spec)) throw new Error('A region needs within (a place), bbox (south, west, north, east) or near (a place or "lat,lon") with radius_km.');
  const notes: string[] = [];
  const parts: string[] = [];
  let members: Set<string> | null = null;
  const overlapsFollowed: Array<{ from: string; to: string }> = [];
  const intersect = (ids: Iterable<string>) => {
    const next = new Set(ids);
    members = members ? new Set([...members].filter((id) => next.has(id))) : next;
  };
  const name = (id: string) => `${graph.nodes.get(id)?.label ?? id} (${id})`;

  if (spec.within) {
    const resolved = resolvePlace(graph, spec.within);
    const root = resolved.node;
    const contained = containedPlaces(graph, root.id, spec.follow_overlaps !== false);
    intersect(contained.members);
    for (const [from, to] of contained.overlapsFollowed) overlapsFollowed.push({ from: name(from), to: name(to) });
    parts.push(`within ${name(root.id)}`);
    if (resolved.alternatives.length) notes.push(`"${spec.within}" is also the name of ${resolved.alternatives.map((n) => name(n.id)).join(', ')}; pass an id to choose.`);
    if (contained.members.size === 1) {
      notes.push(`${name(root.id)} has no places recorded as part of it${root.point ? `; for the area around it use near="${root.id}" with radius_km` : ''}. Only the place itself is used.`);
    }
  }

  if (spec.bbox) {
    const b = spec.bbox;
    if (!(b.south <= b.north)) throw new Error('bbox: south must not be greater than north.');
    intersect([...graph.nodes.values()].filter((n) => n.point && inBox(n.point, b)).map((n) => n.id));
    parts.push(`in the box ${b.south},${b.west} – ${b.north},${b.east} (S,W – N,E)`);
  }

  if (spec.near) {
    const radius = spec.radius_km ?? DEFAULT_RADIUS_KM;
    let center = parsePoint(spec.near);
    let centerName = center ? `${center.lat},${center.lon}` : '';
    if (!center) {
      const resolved = resolvePlace(graph, spec.near);
      if (!resolved.node.point) throw new Error(`${name(resolved.node.id)} has no coordinates; use within, or near with "lat,lon".`);
      center = resolved.node.point;
      centerName = name(resolved.node.id);
      if (resolved.alternatives.length) notes.push(`"${spec.near}" is also the name of ${resolved.alternatives.map((n) => name(n.id)).join(', ')}; pass an id to choose.`);
    }
    intersect(nearbyPlaces(graph, center, radius).map((p) => p.node.id));
    parts.push(`within ${radius} km of ${centerName}`);
  }

  if (spec.bbox || spec.near) {
    const withoutPoint = [...graph.nodes.values()].filter((n) => n.indexed && !n.point && n.documents > 0).length;
    if (withoutPoint) notes.push(`${withoutPoint} places mentioned in the text have no coordinates and can never fall inside a box or radius.`);
  }

  const list = [...(members ?? new Set<string>())].map((id) => graph.nodes.get(id)!).filter(Boolean);
  const linked = list.filter((n) => n.documents > 0).sort((a, b) => b.documents - a.documents);
  return { description: parts.join(' and '), members: list, linked, overlapsFollowed, notes };
}

export async function resolveRegion(spec: RegionSpec): Promise<ResolvedRegion & { graph: PlaceGraph }> {
  const graph = await placeGraph();
  return { ...regionOf(graph, spec), graph };
}

/** Compact description of a place for tool output. */
export function placeBrief(node: PlaceNode, extra: Record<string, unknown> = {}) {
  return {
    id: node.id,
    label: node.label,
    ...(node.point ? { lat: node.point.lat, lon: node.point.lon } : {}),
    documents: node.documents,
    ...extra,
  };
}

export const PLACE_SOURCE = `${config.searchBase}/place-objects/_search`;

// --- Places of writing --------------------------------------------------------------------

const settlementCache = new LruCache<string[]>(1, 6 * 60 * 60_000);

/** Every distinct place of writing (documents.settlement), cached. */
function settlementValues(): Promise<string[]> {
  return settlementCache.getOrCompute('settlements', async () => {
    const data = await esSearch('documents', { size: 0, aggs: { s: { terms: { field: 'settlement', size: 5000 } } } });
    return (data.aggregations?.s?.buckets ?? []).map((b: any) => String(b.key)).filter(Boolean);
  });
}

/**
 * Places of writing whose name is a spelling of a place in the region. The settlement field is
 * text, not a place id, so this is a name match (e.g. "Cochin" → GLOB_299): homonyms can match.
 */
export async function settlementsIn(places: PlaceNode[]): Promise<string[]> {
  const names = new Set(places.flatMap((n) => n.names.map(normaliseName)).filter((n) => n.length > 2));
  return (await settlementValues()).filter((value) => names.has(normaliseName(value)));
}

// --- Places mentioned in documents --------------------------------------------------------

export interface DocumentPlace {
  id: string;
  mentions: number;
  /** Spellings as written, most frequent first. */
  spellings: string[];
}

const SPAN_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const PLACE_ID_RE = /(?:^|&)placeId%3A([^&]+)/g;

/** Linked places in highlight fragments, most mentioned first. Pure. */
export function placesInFragments(fragments: string[]): DocumentPlace[] {
  const tally = new Map<string, { mentions: number; spellings: Map<string, number> }>();
  for (const fragment of fragments) {
    for (const span of fragment.matchAll(SPAN_RE)) {
      const surface = span[1].replace(/\s+/g, ' ').trim();
      for (const match of span[2].matchAll(PLACE_ID_RE)) {
        let id = match[1];
        try {
          id = decodeURIComponent(id);
        } catch {
          // keep as is
        }
        const entry = tally.get(id) ?? { mentions: 0, spellings: new Map() };
        entry.mentions += 1;
        if (surface) entry.spellings.set(surface, (entry.spellings.get(surface) ?? 0) + 1);
        tally.set(id, entry);
      }
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1].mentions - a[1].mentions)
    .map(([id, v]) => ({ id, mentions: v.mentions, spellings: [...v.spellings.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s) }));
}

/**
 * Every linked place in each document (by persistent URI), in one request: the annotated
 * highlighter returns just the spans matching placeId:*, each carrying its own placeId.
 */
export async function placesInDocuments(uris: string[]): Promise<Map<string, DocumentPlace[]>> {
  const out = new Map<string, DocumentPlace[]>();
  if (!uris.length) return out;
  const data = await esSearch<{ id: string }>('documents', {
    size: uris.length,
    _source: ['id'],
    query: { bool: { filter: [{ terms: { id: uris } }] } },
    highlight: {
      fields: {
        annotatedText: { type: 'annotated', fragment_size: 1, number_of_fragments: 10_000, highlight_query: { prefix: { annotatedText: 'placeId:' } } },
      },
    },
  });
  for (const hit of data.hits.hits) out.set(hit._source.id, placesInFragments(hit.highlight?.annotatedText ?? []));
  return out;
}

/** Documents of a result set per candidate place: one filters aggregation per 1000 places. */
export async function placeCountsInResult(query: Record<string, unknown>, candidates: PlaceNode[]): Promise<Map<string, number>> {
  const batches: PlaceNode[][] = [];
  for (let i = 0; i < candidates.length; i += 1000) batches.push(candidates.slice(i, i + 1000));
  const counts = new Map<string, number>();
  await Promise.all(
    batches.map(async (batch) => {
      const data = await esSearch('documents', { size: 0, query, aggs: { places: { filters: { filters: Object.fromEntries(batch.map((n) => [n.id, placeTerm(n.id)])) } } } });
      for (const [id, b] of Object.entries<any>(data.aggregations?.places?.buckets ?? {})) if (b.doc_count) counts.set(id, b.doc_count);
    }),
  );
  return counts;
}
