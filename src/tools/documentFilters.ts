// Parameters shared by search_documents and analyze_distribution, and how they become one
// Elasticsearch query. Both tools must agree exactly, so that a distribution describes the same
// result set the search returns.

import { z } from 'zod';
import { parseId } from '../globalise/ids.ts';
import { regionIds, resolveChips, type Resolution } from '../globalise/lookup.ts';
import { hasRegion, resolveRegion, settlementsIn, type RegionSpec } from '../globalise/places.ts';
import { buildDocumentQuery, buildHighlightQuery, collectChips, dateOverlap, fieldClause, parse, type Chip, type FieldKey, type Node } from '../globalise/query.ts';
import { CAVEATS } from './common.ts';
import { explainPlaces } from './placeExplanation.ts';

export const regionShape = z
  .object({
    within: z.string().optional().describe('A place id or name whose places form the region: everything recorded as part of it, at any depth (e.g. NEW_ADMIN_1076 = Kerala, GLOB_405 = Malabar coast, or "Ceylon"). explore_places shows what a place contains.'),
    bbox: z
      .object({ south: z.number().min(-90).max(90), west: z.number().min(-180).max(180), north: z.number().min(-90).max(90), east: z.number().min(-180).max(180) })
      .optional()
      .describe('A box in decimal degrees; places whose coordinates fall inside.'),
    near: z.string().optional().describe('A centre: place id or name, or "lat,lon"; with radius_km.'),
    radius_km: z.number().min(0.1).max(3000).optional().describe('Radius around near (default 25 km).'),
    follow_overlaps: z.boolean().default(true).describe('within: also include places recorded as overlapping a place in the region (other senses of a name: the city, kingdom and Company settlement of the same name). Text mentions are usually linked to only one of these.'),
  })
  .describe('Limit to a geographic region. Criteria given together are intersected.');

export const documentFilterShape = {
  query: z
    .string()
    .max(2000)
    .optional()
    .describe('Search expression over the transcriptions (see globalise_about topic query_syntax): words, "phrases", wildcards*, fuzzy~1, AND/OR/NOT, (a b)~5 proximity, and fields such as place:GLOB2_937, within:NEW_ADMIN_1076 (any place in a region), role:koopman, annotation:Payment, year:1680-1690. Write in period Dutch; include spelling variants with OR.'),
  entities: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('Ids or URIs of reference records that must be mentioned (all of them): places (GLOB2_…), persons (Person_…), ships (gzm_ship…), organisations (ORG_…), polities (Polity_…) or thesaurus concepts (uuid). Places and concepts match by id (that exact place only; for the places inside or around it use region); persons/ships/organisations/polities by all recorded spellings.'),
  year_from: z.number().int().min(1500).max(1900).optional().describe('Earliest year (documents whose date range overlaps).'),
  year_to: z.number().int().min(1500).max(1900).optional().describe('Latest year.'),
  settlement: z.string().optional().describe('Place of writing as in the settlement field, e.g. Batavia, Ceylon, Coromandel, Bengale, "Goede Hoop". Wildcards allowed.'),
  inventory: z.string().optional().describe('Inventory (volume) number, e.g. 1968.'),
  document_type: z.string().optional().describe('Document type: thesaurus label (e.g. brief, resolutie, dagregister) or concept id.'),
  region: regionShape.optional(),
  region_applies_to: z
    .enum(['mentions', 'place_of_writing', 'either'])
    .default('mentions')
    .describe('mentions: the text mentions a place in the region (linked place tags); place_of_writing: the settlement field names a place in the region (name match); either.'),
};

export type DocumentFilterArgs = {
  query?: string;
  entities?: string[];
  year_from?: number;
  year_to?: number;
  settlement?: string;
  inventory?: string;
  document_type?: string;
  region?: RegionSpec;
  region_applies_to?: 'mentions' | 'place_of_writing' | 'either';
};

const KIND_TO_FIELD: Record<string, FieldKey> = {
  place: 'place',
  person: 'person',
  ship: 'ship',
  group: 'organisation',
  polity: 'polity',
  thesaurus: 'concept',
};

export interface BuiltDocumentQuery {
  query: Record<string, unknown>;
  highlight: Record<string, unknown> | null;
  tree: Node | null;
  chips: Chip[];
  resolutions: Resolution[];
  caveats: string[];
  /** Which place data and mentions the search used, what it left out, limitations; null without places. */
  placeExplanation: Record<string, unknown> | null;
}

export async function buildFromArgs(args: DocumentFilterArgs): Promise<BuiltDocumentQuery> {
  const tree = parse(args.query ?? '');
  const chips: Chip[] = [];
  const unknown: string[] = [];

  for (const entity of args.entities ?? []) {
    const parsed = parseId(entity);
    const field = parsed ? KIND_TO_FIELD[parsed.kind] : undefined;
    if (!parsed || !field) unknown.push(entity);
    else chips.push({ fieldKey: field, value: parsed.id });
  }
  if (unknown.length) throw new Error(`Not a place, person, ship, organisation, polity or concept id: ${unknown.join(', ')}. Use search_reference_data to find ids.`);

  if (args.settlement) chips.push({ fieldKey: 'settlement', value: args.settlement });
  if (args.inventory) chips.push({ fieldKey: 'inventory', value: args.inventory });
  if (args.document_type) chips.push({ fieldKey: 'documenttype', value: args.document_type });

  const regionResolutions: Resolution[] = [];
  const filters: Record<string, unknown>[] = [];
  let regionHighlight: Record<string, unknown> | null = null;
  let regionSettlements: string[] | undefined;
  if (hasRegion(args.region)) {
    const scope = args.region_applies_to ?? 'mentions';
    const mentions = scope === 'place_of_writing' ? null : await regionIds(args.region);
    let written: Record<string, unknown> | null = null;
    if (scope !== 'mentions') {
      const region = await resolveRegion(args.region);
      const settlements = await settlementsIn(region.members);
      regionSettlements = settlements;
      written = settlements.length ? { terms: { settlement: settlements } } : { match_none: {} };
      regionResolutions.push({
        field: 'region (place of writing)',
        input: JSON.stringify(args.region),
        resolvedTo: settlements.length ? settlements.join(' | ') : 'no place of writing matches',
        method: 'places of writing (settlement field, plain text) whose name equals a spelling of a place in the region; homonyms can match',
      });
    }
    if (mentions) regionResolutions.push(mentions.resolution);
    if (scope === 'mentions') chips.push({ fieldKey: 'within', value: mentions!.resolution.input, id: 'region', ids: mentions!.ids });
    else if (scope === 'place_of_writing') filters.push(written!);
    else {
      const mentionsClause = fieldClause({ fieldKey: 'within', value: 'region', ids: mentions!.ids })!;
      filters.push({ bool: { should: [mentionsClause, written!], minimum_should_match: 1 } });
      regionHighlight = mentionsClause;
    }
  }

  const resolutions = [...(await resolveChips([...collectChips(tree), ...chips])), ...regionResolutions];
  const dates = dateOverlap(args.year_from, args.year_to);
  if (dates) filters.push(dates);
  const query = buildDocumentQuery(tree, chips, filters);
  const textHighlight = buildHighlightQuery(tree, chips);
  const highlight = textHighlight && regionHighlight ? { bool: { should: [textHighlight, regionHighlight], minimum_should_match: 1 } } : (textHighlight ?? regionHighlight);

  const allChips = [...collectChips(tree), ...chips];
  const caveats: string[] = [CAVEATS.htr, CAVEATS.documents];
  if (allChips.some((c) => ['person', 'ship', 'organisation', 'polity'].includes(c.fieldKey))) caveats.push(CAVEATS.names);
  if (allChips.some((c) => ['place', 'within', 'role', 'annotation', 'concept', 'profession'].includes(c.fieldKey)) || hasRegion(args.region)) caveats.push(CAVEATS.annotations);
  if (allChips.some((c) => c.fieldKey === 'within') || hasRegion(args.region)) caveats.push(CAVEATS.regions);
  if (allChips.some((c) => ['role', 'concept'].includes(c.fieldKey))) caveats.push(CAVEATS.roles);

  const placeExplanation = await explainPlaces({ chips: allChips, region: args.region, scope: args.region_applies_to, regionSettlements });
  return { query, highlight, tree, chips: allChips, resolutions, caveats, placeExplanation };
}
