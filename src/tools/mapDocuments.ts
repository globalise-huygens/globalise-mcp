import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mapViewerToolMeta } from '../apps/mapViewer.ts';
import { config } from '../config.ts';
import { countBody, countOf, esMsearch } from '../globalise/es.ts';
import {
  anyPlaceClause,
  DEFAULT_RADIUS_KM,
  hasRegion,
  parsePoint,
  PLACE_SOURCE,
  placeCountsInResult,
  placeGraph,
  labelsNote,
  regionOf,
  withPrefLabels,
  resolvePlace,
  type PlaceGraph,
  type PlaceNode,
  type RegionSpec,
} from '../globalise/places.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';
import { buildFromArgs, documentFilterShape, type DocumentFilterArgs } from './documentFilters.ts';
import { placeDataExplanation } from './placeExplanation.ts';

type Args = DocumentFilterArgs & { max_places?: number };

const FILTER_KEYS = Object.keys(documentFilterShape) as Array<keyof DocumentFilterArgs>;

const rate = (count: number, corpus: number) => (corpus ? Math.round((count / corpus) * 10_000) / 10 : 0);

export function registerMapDocuments(server: McpServer) {
  server.registerTool(
    'map_documents',
    {
      title: 'Map the places mentioned in search results',
      description:
        'Puts a search (same filters as search_documents, including region) on a map: for every linked place with coordinates, the number of matching documents that mention it, its corpus count and the rate per 1000, plus the region outline. In clients that support MCP Apps this opens an interactive globe/map (click a place to list its documents); otherwise use the returned coordinates to draw a map yourself. Use when the user asks where something happens, wants a map or globe, or to see the geography of a result set.',
      inputSchema: {
        ...documentFilterShape,
        max_places: z.number().int().min(10).max(1000).default(300).describe('Most-mentioned places to return.'),
      },
      annotations: { ...READ_ONLY, title: 'Map documents' },
      _meta: mapViewerToolMeta,
    },
    safe(async (args: Args) => {
      const [built, graph] = await Promise.all([buildFromArgs(args), placeGraph()]);
      const candidates: PlaceNode[] = hasRegion(args.region) ? regionOf(graph, args.region).linked : [...graph.nodes.values()].filter((n) => n.documents > 0);
      const mappable = candidates.filter((n) => n.point);
      const [counts, [total, withPlace]] = await Promise.all([
        placeCountsInResult(built.query, candidates),
        esMsearch([
          { index: 'documents', body: countBody(built.query) },
          { index: 'documents', body: countBody({ bool: { must: [built.query], filter: [anyPlaceClause(mappable.map((n) => n.id))] } }) },
        ]),
      ]);

      const rows = [...counts.entries()].map(([id, documents]) => ({ node: graph.nodes.get(id)!, documents })).sort((a, b) => b.documents - a.documents);
      const searched = new Set(built.chips.flatMap((c) => (c.fieldKey === 'within' ? (c.ids ?? []) : c.fieldKey === 'place' && c.id ? [c.id] : [])));
      const describe = ({ node, documents }: { node: PlaceNode; documents: number }) => ({
        id: node.id,
        label: node.label,
        ...(node.names.length > 1 ? { also_recorded_as: node.names.filter((n) => n !== node.label).slice(0, 4) } : {}),
        ...(node.point ? { lat: node.point.lat, lon: node.point.lon } : {}),
        documents,
        corpus_documents: node.documents,
        per_1000_corpus_documents: rate(documents, node.documents),
        part_of: node.parents.map((p) => graph.nodes.get(p)?.label ?? p),
        ...(searched.has(node.id) ? { searched: true } : {}),
      });
      const maxPlaces = args.max_places ?? 300;
      const placed = rows.filter((r) => r.node.point);
      const unplaced = rows.filter((r) => !r.node.point);
      const shown = [...placed.slice(0, maxPlaces), ...unplaced.slice(0, 15)].map((r) => r.node);
      const unlabelled = await withPrefLabels(graph, shown.flatMap((n) => [n.id, ...n.parents]));
      const filters = Object.fromEntries(FILTER_KEYS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

      return json({
        kind: 'globalise-map',
        title: mapTitle(args),
        matching_documents: countOf(total),
        documents_mentioning_a_mapped_place: countOf(withPlace),
        places_on_map: Math.min(placed.length, maxPlaces),
        places_with_coordinates: placed.length,
        places: placed.slice(0, maxPlaces).map(describe),
        places_without_coordinates: { total: unplaced.length, top: unplaced.slice(0, 15).map(describe) },
        region_outline: outline(graph, args.region),
        ...labelsNote(unlabelled),
        filters,
        query_interpretation: built.resolutions,
        ...(built.placeExplanation ? { place_search_explanation: built.placeExplanation } : {}),
        place_data_explanation: placeDataExplanation(true),
        how_to_read:
          'Each point is one place record with coordinates; documents = matching documents whose text links a mention to it (a document mentioning several places counts at each). per_1000_corpus_documents = documents / all documents mentioning the place × 1000: compare places with it, not with raw counts. Documents that mention no linked place with coordinates are not on the map (matching_documents − documents_mentioning_a_mapped_place). The land outline is modern (Natural Earth); points are single coordinates, not boundaries. label = the preferred label of the place record (often a modern name, e.g. Jakarta for Batavia); also_recorded_as = other recorded spellings.',
        provenance: provenance([`${config.searchBase}/documents/_search`, PLACE_SOURCE], [...built.caveats, CAVEATS.regions, CAVEATS.coverage], [graph.indexVersion, await indexVersion('documents')]),
      });
    }),
  );
}

function mapTitle(args: Args): string {
  const parts = [args.query, ...(args.entities ?? []), args.settlement && `written at ${args.settlement}`, args.document_type].filter(Boolean);
  const years = args.year_from || args.year_to ? `${args.year_from ?? '…'}–${args.year_to ?? '…'}` : '';
  return [parts.join(' · ') || 'All documents', years].filter(Boolean).join(', ');
}

/** What to draw around the region: a box or a circle. "within" regions have no outline (places are marked as searched). */
function outline(graph: PlaceGraph, spec: RegionSpec | undefined) {
  if (!spec) return null;
  if (spec.bbox) return { type: 'bbox', ...spec.bbox };
  if (spec.near) {
    const center = parsePoint(spec.near) ?? resolvePlace(graph, spec.near).node.point;
    return center ? { type: 'circle', lat: center.lat, lon: center.lon, radius_km: spec.radius_km ?? DEFAULT_RADIUS_KM } : null;
  }
  return null;
}
