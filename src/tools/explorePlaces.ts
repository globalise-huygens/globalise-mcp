import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.ts';
import { conceptLabels } from '../globalise/concepts.ts';
import { countBody, countOf, esMsearch } from '../globalise/es.ts';
import { objectCardUrl, uriFor } from '../globalise/ids.ts';
import {
  anyPlaceClause,
  broaderChains,
  containedPlaces,
  hasRegion,
  nearbyPlaces,
  PLACE_SOURCE,
  placeBrief,
  parsePoint,
  placeGraph,
  labelsNote,
  regionWithLabels,
  withPrefLabels,
  resolvePlace,
  type PlaceGraph,
  type PlaceNode,
  type RegionSpec,
} from '../globalise/places.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';
import { regionShape } from './documentFilters.ts';
import { placeDataExplanation } from './placeExplanation.ts';

type Sort = 'documents' | 'name' | 'distance';

type Args = {
  place?: string;
  region?: RegionSpec;
  nearby_km?: number;
  include_unlinked?: boolean;
  sort?: Sort;
  limit?: number;
};

const label = (graph: PlaceGraph, id: string) => graph.nodes.get(id)?.label ?? id;

async function classificationLabels(nodes: PlaceNode[]): Promise<Map<string, string>> {
  return conceptLabels(nodes.flatMap((n) => n.classifications));
}

function describe(node: PlaceNode, labels: Map<string, string>, extra: Record<string, unknown> = {}) {
  return placeBrief(node, {
    ...(node.classifications.length ? { types: node.classifications.map((c) => labels.get(c) ?? c) } : {}),
    ...extra,
  });
}

export function registerExplorePlaces(server: McpServer) {
  server.registerTool(
    'explore_places',
    {
      title: 'Explore places, their relations and regions',
      description:
        'The geography of the place records. With place: its coordinates, types, the places it is part of (chains up to the largest region), the places it contains, places recorded as overlapping it (other senses of the same name: city, kingdom, Company settlement), and places nearby, each with the number of documents mentioning it. With region (a place to look inside, a bounding box, or a radius around a place or point): every place in it, most mentioned first, and how many documents mention any of them. Use it to choose and check a region before passing the same region to search_documents, analyze_distribution or count_mentions, or to answer "what lies near / inside X".',
      inputSchema: {
        place: z.string().optional().describe('A place id (GLOB2_…, GLOB_…, NEW_ADMIN_… for modern administrative regions) or name.'),
        region: regionShape.optional(),
        nearby_km: z.number().min(0).max(1000).default(25).describe('place: also list places within this distance (0 = none).'),
        include_unlinked: z.boolean().default(false).describe('Also list places that no text mention is linked to (they cannot be found in documents, but show the geography).'),
        sort: z.enum(['documents', 'name', 'distance']).default('documents').describe('Order of listed places; distance needs a centre (place or region.near).'),
        limit: z.number().int().min(1).max(200).default(30).describe('Places per list.'),
      },
      annotations: { ...READ_ONLY, title: 'Explore places' },
    },
    safe(async (args: Args) => {
      if (!args.place && !hasRegion(args.region)) throw new Error('Give a place (id or name), a region, or both.');
      const graph = await placeGraph();
      const limit = args.limit ?? 30;
      const keep = (n: PlaceNode) => args.include_unlinked || n.documents > 0;
      const out: Record<string, unknown> = {};
      const caveats: string[] = [CAVEATS.referenceData, CAVEATS.regions];
      let unlabelled = 0;

      if (args.place) {
        const resolved = resolvePlace(graph, args.place);
        const node = resolved.node;
        const contained = containedPlaces(graph, node.id, true);
        const containedNodes = [...contained.members].filter((id) => id !== node.id).map((id) => graph.nodes.get(id)!).filter(Boolean);
        const nearby = node.point && (args.nearby_km ?? 25) > 0 ? nearbyPlaces(graph, node.point, args.nearby_km ?? 25, node.id).filter((p) => keep(p.node)) : [];
        const chains = broaderChains(graph, node.id);
        const related = [
          ...node.parents,
          ...node.children,
          ...node.overlaps,
          ...chains.flatMap((c) => c.chain.map((n) => n.id)),
        ].map((id) => graph.nodes.get(id)!).filter(Boolean);
        unlabelled += await withPrefLabels(graph, [node, ...related, ...resolved.alternatives, ...nearby.slice(0, limit).map((p) => p.node)].map((n) => n.id));
        const labels = await classificationLabels([node, ...related, ...nearby.map((p) => p.node), ...containedNodes.slice(0, limit)]);

        const [anyInside] = await esMsearch([{ index: 'documents', body: countBody(anyPlaceClause(containedNodes.concat(node).filter((n) => n.documents > 0).map((n) => n.id))) }]);
        out.place = {
          ...describe(node, labels),
          names: node.names,
          label_note: node.prefLabelLoaded ? 'label = the preferred label of the place record; names = all recorded spellings' : 'label = first recorded spelling (preferred label not loaded)',
          resolved_by: resolved.method,
          ...(resolved.alternatives.length ? { other_places_with_this_name: resolved.alternatives.map((n) => describe(n, labels)) } : {}),
          has_own_record: node.indexed,
          ...(node.indexed
            ? { uri: uriFor('place', node.id), object_card_url: objectCardUrl(uriFor('place', node.id)) }
            : { note: 'Known only as a region that other places are part of (no record of its own in the place index, no coordinates, never linked in the text).' }),
        };
        out.relations = {
          part_of: node.parents.map((id) => describe(graph.nodes.get(id)!, labels)),
          broader_chains: chains.map((c) => ({
            starting_from: c.from === node.id ? 'this place' : `overlapping place ${label(graph, c.from)} (${c.from})`,
            chain: c.chain.map((n) => `${n.label} (${n.id})`).join(' → '),
          })),
          overlaps: node.overlaps.map((id) => describe(graph.nodes.get(id)!, labels)),
          contains_directly: sortPlaces(node.children.map((id) => graph.nodes.get(id)!).filter(keep), args.sort, node.point).slice(0, limit).map((n) => describe(n, labels)),
          contains_total: {
            places: containedNodes.length,
            linked_in_text: containedNodes.filter((n) => n.documents > 0).length,
            documents_mentioning_it_or_any_contained_place: countOf(anyInside),
            note: 'Contained = part of it at any depth, including places overlapping those (as region.within does with follow_overlaps).',
          },
          ...(node.point && (args.nearby_km ?? 25) > 0
            ? {
                nearby: {
                  radius_km: args.nearby_km ?? 25,
                  total: nearby.length,
                  places: (args.sort === 'documents' ? [...nearby].sort((a, b) => b.node.documents - a.node.documents) : args.sort === 'name' ? [...nearby].sort((a, b) => a.node.label.localeCompare(b.node.label)) : nearby)
                    .slice(0, limit)
                    .map((p) => describe(p.node, labels, { km: p.km })),
                },
              }
            : {}),
        };
        out.how_to_search = {
          this_place_only: `entities=["${node.id}"] or query place:${node.id}`,
          including_contained_places: `region={"within":"${node.id}"} or query within:${node.id}`,
          ...(node.point ? { area_around_it: `region={"near":"${node.id}","radius_km":${args.nearby_km || 25}}` } : {}),
        };
      }

      if (hasRegion(args.region)) {
        const region = await regionWithLabels(graph, args.region, limit);
        const center = args.region.near ? (parsePoint(args.region.near) ?? resolvePlace(graph, args.region.near).node.point) : null;
        const listed = sortPlaces(region.members.filter(keep), args.sort, center);
        unlabelled += await withPrefLabels(graph, listed.slice(0, limit).flatMap((n) => [n.id, ...n.parents]));
        const labels = await classificationLabels(listed.slice(0, limit));
        const [any] = await esMsearch([{ index: 'documents', body: countBody(anyPlaceClause(region.linked.map((n) => n.id))) }]);
        out.region = {
          description: region.description,
          places_in_region: region.members.length,
          places_linked_in_text: region.linked.length,
          documents_mentioning_any: countOf(any),
          places: listed.slice(0, limit).map((n) => describe(n, labels, { part_of: n.parents.map((id) => label(graph, id)) })),
          ...(listed.length > limit ? { more: `${listed.length - limit} more; raise limit (max 200)` } : {}),
          ...(region.overlapsFollowed.length ? { overlaps_followed: region.overlapsFollowed.slice(0, 20).map((o) => `${o.from} overlaps ${o.to}`) } : {}),
          ...(region.notes.length ? { notes: region.notes } : {}),
          how_to_search: `Pass region=${JSON.stringify(args.region)} to search_documents, analyze_distribution (dimension "place" ranks these places in a result set) or count_mentions.`,
        };
      }

      return json({
        ...out,
        ...labelsNote(unlabelled),
        place_data_explanation: placeDataExplanation(!!(args.region?.bbox || args.region?.near || (args.nearby_km ?? 25) > 0)),
        how_to_read:
          'documents = documents in the whole corpus whose text links a mention to this place id. Places with 0 documents (for example the GAVOC atlas places and modern administrative regions) are never linked in the text; a region finds documents only through the linked places inside it.',
        provenance: provenance([PLACE_SOURCE, `${config.searchBase}/documents/_search`], caveats, [graph.indexVersion, await indexVersion('documents')]),
      });
    }),
  );
}

function sortPlaces(nodes: PlaceNode[], sort: Sort | undefined, center: { lat: number; lon: number } | null): PlaceNode[] {
  const list = [...nodes];
  if (sort === 'name') return list.sort((a, b) => a.label.localeCompare(b.label));
  if (sort === 'distance' && center) {
    const d = (n: PlaceNode) => (n.point ? (n.point.lat - center.lat) ** 2 + ((n.point.lon - center.lon) * Math.cos((center.lat * Math.PI) / 180)) ** 2 : Infinity);
    return list.sort((a, b) => d(a) - d(b));
  }
  return list.sort((a, b) => b.documents - a.documents || a.label.localeCompare(b.label));
}
