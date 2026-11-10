// Parameters shared by search_documents and analyze_distribution, and how they become one
// Elasticsearch query. Both tools must agree exactly, so that a distribution describes the same
// result set the search returns.

import { z } from 'zod';
import { parseId } from '../globalise/ids.ts';
import { resolveChips, type Resolution } from '../globalise/lookup.ts';
import { buildDocumentQuery, buildHighlightQuery, collectChips, dateOverlap, parse, type Chip, type FieldKey, type Node } from '../globalise/query.ts';
import { CAVEATS } from './common.ts';

export const documentFilterShape = {
  query: z
    .string()
    .max(2000)
    .optional()
    .describe('Search expression over the transcriptions (see globalise_about topic query_syntax): words, "phrases", wildcards*, fuzzy~1, AND/OR/NOT, (a b)~5 proximity, and fields such as place:GLOB2_937, role:koopman, annotation:Payment, year:1680-1690. Write in period Dutch; include spelling variants with OR.'),
  entities: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('Ids or URIs of reference records that must be mentioned (all of them): places (GLOB2_…), persons (Person_…), ships (gzm_ship…), organisations (ORG_…), polities (Polity_…) or thesaurus concepts (uuid). Places and concepts match by id; persons/ships/organisations/polities by all recorded spellings.'),
  year_from: z.number().int().min(1500).max(1900).optional().describe('Earliest year (documents whose date range overlaps).'),
  year_to: z.number().int().min(1500).max(1900).optional().describe('Latest year.'),
  settlement: z.string().optional().describe('Place of writing as in the settlement field, e.g. Batavia, Ceylon, Coromandel, Bengale, "Goede Hoop". Wildcards allowed.'),
  inventory: z.string().optional().describe('Inventory (volume) number, e.g. 1968.'),
  document_type: z.string().optional().describe('Document type: thesaurus label (e.g. brief, resolutie, dagregister) or concept id.'),
};

export type DocumentFilterArgs = {
  query?: string;
  entities?: string[];
  year_from?: number;
  year_to?: number;
  settlement?: string;
  inventory?: string;
  document_type?: string;
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

  const resolutions = await resolveChips([...collectChips(tree), ...chips]);
  const dates = dateOverlap(args.year_from, args.year_to);
  const query = buildDocumentQuery(tree, chips, dates ? [dates] : []);
  const highlight = buildHighlightQuery(tree, chips);

  const allChips = [...collectChips(tree), ...chips];
  const caveats: string[] = [CAVEATS.htr, CAVEATS.documents];
  if (allChips.some((c) => ['person', 'ship', 'organisation', 'polity'].includes(c.fieldKey))) caveats.push(CAVEATS.names);
  if (allChips.some((c) => ['place', 'role', 'annotation', 'concept', 'profession'].includes(c.fieldKey))) caveats.push(CAVEATS.annotations);
  if (allChips.some((c) => ['role', 'concept'].includes(c.fieldKey))) caveats.push(CAVEATS.roles);

  return { query, highlight, tree, chips: allChips, resolutions, caveats };
}
