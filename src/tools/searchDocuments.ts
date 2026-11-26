import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.ts';
import { renderFragment, viewerHitQuery, viewerSnippet, type TextFormat } from '../globalise/annotatedText.ts';
import { esSearch } from '../globalise/es.ts';
import { uriFor, viewerUrlForDocument } from '../globalise/ids.ts';
import { mentionsForDocuments, topEntries, type MentionTally } from '../globalise/mentions.ts';
import { placeGraph, placesInDocuments, type DocumentPlace, type PlaceGraph } from '../globalise/places.ts';
import type { Chip } from '../globalise/query.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';
import { buildFromArgs, documentFilterShape, type DocumentFilterArgs } from './documentFilters.ts';

interface DocSource {
  id: string;
  identifier: string;
  title?: string;
  settlement?: string;
  inventoryNumber?: string;
  scanCount?: number;
  startDate?: string;
  endDate?: string;
  archiveDescription?: string;
}

const SORTS = {
  relevance: undefined,
  date_asc: [{ startDate: 'asc' }, '_score'],
  date_desc: [{ endDate: 'desc' }, '_score'],
} as const;

type Args = DocumentFilterArgs & {
  sort?: keyof typeof SORTS;
  page?: number;
  page_size?: number;
  snippets_per_document?: number;
  snippet_format?: TextFormat;
  exact_total?: boolean;
  count_mentions?: boolean;
  show_es_query?: boolean;
  places_per_document?: number;
  geojson?: boolean;
};

export function registerSearchDocuments(server: McpServer) {
  server.registerTool(
    'search_documents',
    {
      title: 'Search VOC documents',
      description:
        'Search the Globalise corpus of machine-transcribed VOC documents (mostly 1605–1794) by text, tagged entities, date, place of writing, inventory and document type. Returns documents with highlighted snippets (matches in «»), dates, ids and viewer links; when there are text matches, the viewer link opens the scan of the first snippet with the matched words highlighted. The text is early-modern Dutch: search with period spellings and variants. Results are documents, not individual mentions.',
      inputSchema: {
        ...documentFilterShape,
        sort: z.enum(['relevance', 'date_asc', 'date_desc']).default('relevance'),
        page: z.number().int().min(1).max(400).default(1),
        page_size: z.number().int().min(1).max(25).default(10),
        snippets_per_document: z.number().int().min(0).max(5).default(3),
        snippet_format: z.enum(['plain', 'inline']).default('inline').describe('inline keeps entity tags as [text]{Type place:ID role:ID}; plain is just the text.'),
        exact_total: z.boolean().default(false).describe('Count all hits exactly (slower for broad queries); otherwise totals above 10,000 are reported as "10000+".'),
        count_mentions: z.boolean().default(true).describe('Count the occurrences of the search terms in each returned document (and the spellings matched).'),
        show_es_query: z.boolean().default(false).describe('Include the Elasticsearch query for reproducibility.'),
        places_per_document: z.number().int().min(0).max(50).default(10).describe('List this many linked places per document (most mentioned first), with coordinates and mention counts; 0 = none.'),
        geojson: z.boolean().default(false).describe('Also return the places of this page as a GeoJSON FeatureCollection (points with document ids), e.g. to draw a map. For a map of the whole result set use map_documents.'),
      },
      annotations: { ...READ_ONLY, title: 'Search VOC documents' },
    },
    safe(async (args: Args) => {
      const built = await buildFromArgs(args);
      const pageSize = args.page_size ?? 10;
      const page = args.page ?? 1;
      const from = (page - 1) * pageSize;
      if (from + pageSize > 10_000) throw new Error('Elasticsearch cannot page beyond 10,000 hits; narrow the query (e.g. by year or settlement).');

      const fragments = args.snippets_per_document ?? 3;
      const body: Record<string, unknown> = {
        from,
        size: pageSize,
        track_total_hits: args.exact_total ? true : 10_000,
        _source: ['id', 'identifier', 'title', 'settlement', 'inventoryNumber', 'scanCount', 'startDate', 'endDate', 'archiveDescription'],
        query: built.query,
      };
      const sort = SORTS[args.sort ?? 'relevance'];
      if (sort) body.sort = sort;
      if (fragments > 0) {
        body.highlight = {
          fields: {
            annotatedText: {
              type: 'annotated',
              fragment_size: 240,
              number_of_fragments: fragments,
              no_match_size: 240,
              ...(built.highlight ? { highlight_query: built.highlight } : {}),
            },
          },
        };
      }

      const response = await esSearch<DocSource>('documents', body);
      const total = response.hits.total;
      const format = args.snippet_format ?? 'inline';

      // Mentions per document on this page: one extra, light request (matching spans only).
      const countMentions = args.count_mentions !== false && built.highlight && response.hits.hits.length;
      const mentions = countMentions
        ? await mentionsForDocuments(built.query, built.highlight!, response.hits.hits.map((h) => h._source.id))
        : new Map<string, MentionTally>();

      // Linked places per document on this page: one extra request (only the place spans).
      const placesPer = args.places_per_document ?? 10;
      const [docPlaces, graph] = placesPer > 0 && response.hits.hits.length
        ? await Promise.all([placesInDocuments(response.hits.hits.map((h) => h._source.id)), placeGraph().catch(() => null)])
        : [new Map<string, DocumentPlace[]>(), null];
      const searched = searchedPlaceIds(built.chips);

      const results = response.hits.hits.map((hit) => {
        const s = hit._source;
        const series = s.archiveDescription?.split(' • ');
        const tally = mentions.get(s.id);
        const documentId = s.identifier ?? hit._id;
        const fragmentsOfHit = hit.highlight?.annotatedText ?? [];
        return {
          document_id: s.identifier ?? hit._id,
          title: s.title,
          date: s.startDate === s.endDate ? s.startDate : `${s.startDate ?? '?'} / ${s.endDate ?? '?'}`,
          settlement: s.settlement || null,
          inventory: s.inventoryNumber,
          scans: s.scanCount,
          archive_series: series && series.length > 2 ? series.slice(-2).join(' • ') : s.archiveDescription,
          score: hit._score,
          ...(tally
            ? { mentions: tally.total, spellings: topEntries(tally.bySurface, 5).map((e) => `${e.key} (${e.count})`) }
            : {}),
          snippets: fragmentsOfHit.map((f) => renderFragment(f, format)),
          ...(placesPer > 0 ? documentPlaces(docPlaces.get(s.id) ?? [], graph, searched, placesPer) : {}),
          viewer_url: viewerUrlForDocument(documentId, viewerHighlight(fragmentsOfHit)),
          uri: uriFor('document', s.identifier ?? hit._id),
        };
      });

      return json({
        total: total.relation === 'gte' ? `${total.value}+` : total.value,
        total_counts: 'documents (use count_mentions for the number of occurrences)',
        page,
        page_size: pageSize,
        has_more: from + results.length < Math.min(total.value, 10_000),
        query_interpretation: built.resolutions,
        ...(built.placeExplanation ? { place_search_explanation: built.placeExplanation } : {}),
        ...(countMentions ? { mentions_on_this_page: [...mentions.values()].reduce((s, t) => s + t.total, 0) } : {}),
        results,
        ...(args.geojson && graph ? { geojson: pageGeojson(results, graph) } : {}),
        ...(placesPer > 0
          ? {
              places_note:
                'places = places linked to mentions anywhere in the document (automatic linking; wrong and missing links occur), most mentioned first; searched = matched by a place, within: or region criterion of this search. Places without lat/lon have no coordinates. spellings show what was actually linked: an implausible spelling (e.g. "Jndien" linked to Londen) is a wrong link.',
            }
          : {}),
        next_steps: results.length
          ? 'Use get_document for full text and tags, get_scan (with quote=…) to verify a passage on the scan, analyze_distribution to see how documents spread over time and places, count_mentions for total occurrences.'
          : 'No hits. Try spelling variants (OR), wildcards (*), fuzzy (~), fewer filters, or an entity id from search_reference_data.',
        provenance: provenance(
          [`${config.searchBase}/documents/_search`],
          [...built.caveats, CAVEATS.verify],
          response.hits.hits.length ? response.hits.hits.map((h) => h._index) : [await indexVersion('documents')],
        ),
        ...(args.show_es_query ? { es_query: body } : {}),
      });
    }),
  );
}

/** Highlight for the viewer link: all matched words, and the first snippet that has a match. */
function viewerHighlight(fragments: string[]) {
  const q = viewerHitQuery(fragments);
  const snippet = fragments.map(viewerSnippet).find(Boolean);
  return q && snippet ? { q, snippet } : null;
}

/** Place ids that a place:, within: or region criterion searched for. */
function searchedPlaceIds(chips: Chip[]): Set<string> {
  const ids = new Set<string>();
  for (const chip of chips) {
    if (chip.fieldKey === 'place' && chip.id) ids.add(chip.id);
    if (chip.fieldKey === 'within') for (const id of chip.ids ?? []) ids.add(id);
  }
  return ids;
}

function documentPlaces(places: DocumentPlace[], graph: PlaceGraph | null, searched: Set<string>, limit: number) {
  return {
    places_total: places.length,
    places: places.slice(0, limit).map((p) => {
      const node = graph?.nodes.get(p.id);
      return {
        id: p.id,
        label: node?.label ?? p.id,
        ...(node?.point ? { lat: node.point.lat, lon: node.point.lon } : {}),
        mentions: p.mentions,
        spellings: p.spellings.slice(0, 4),
        ...(searched.has(p.id) ? { searched: true } : {}),
      };
    }),
  };
}

/** The places on this page as GeoJSON points, with the documents mentioning each. */
function pageGeojson(results: Array<{ document_id: string; places?: Array<{ id: string; mentions: number }> }>, graph: PlaceGraph) {
  const byPlace = new Map<string, { mentions: number; documents: string[] }>();
  for (const result of results) {
    for (const place of result.places ?? []) {
      const entry = byPlace.get(place.id) ?? { mentions: 0, documents: [] };
      entry.mentions += place.mentions;
      entry.documents.push(result.document_id);
      byPlace.set(place.id, entry);
    }
  }
  const features = [...byPlace.entries()].flatMap(([id, v]) => {
    const node = graph.nodes.get(id);
    if (!node?.point) return [];
    return [{
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [node.point.lon, node.point.lat] },
      properties: { id, label: node.label, documents_on_page: v.documents.length, mentions_on_page: v.mentions, document_ids: v.documents, corpus_documents: node.documents },
    }];
  });
  return { type: 'FeatureCollection' as const, features, places_without_coordinates: [...byPlace.keys()].filter((id) => !graph.nodes.get(id)?.point) };
}
