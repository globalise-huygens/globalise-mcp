// Thesaurus concepts: labels, hierarchy and schemes. The search index lists a concept's labels in no
// particular order (soldaat shows up as "Dashi") and has no broader/narrower links, so labels and the
// hierarchy come from the concept's JSON-LD record; scheme membership comes from the index facets.

import { LruCache } from '../util/cache.ts';
import { fetchJson } from '../util/http.ts';
import { esMsearch, esSearch, splitTitles } from './es.ts';
import { parseId, uriFor } from './ids.ts';
import { labelOf } from './linkedart.ts';
import { labelsFor, resolveConcept } from './lookup.ts';

type Json = Record<string, any>;

export interface ConceptRef {
  id: string;
  label: string;
}

export interface Concept extends ConceptRef {
  uri: string;
  type: 'Concept' | 'ConceptScheme';
  labels: { nl?: string; en?: string };
  definition?: string;
  schemes: ConceptRef[];
  broader: ConceptRef[];
  /** Narrower concepts, or for a scheme its top concepts. */
  narrower: ConceptRef[];
}

const asArray = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const idOf = (uri: unknown): string => parseId(String(uri))?.id ?? String(uri).split(':').pop() ?? String(uri);
const refOf = (node: Json): ConceptRef => ({ id: idOf(node.id), label: labelOf(node) ?? idOf(node.id) });

function languageValue(values: unknown, language: string): string | undefined {
  const hit = asArray(values as Json[]).find((v) => v && typeof v === 'object' && v['@language'] === language);
  return hit ? String(hit['@value']) : undefined;
}

export async function conceptRecord(id: string): Promise<Concept> {
  const uri = uriFor('thesaurus', id);
  const record = await fetchJson<Json>(uri);
  const type = asArray(record.type).includes('ConceptScheme') ? 'ConceptScheme' : 'Concept';
  const definition = languageValue(record.definition, 'en') ?? languageValue(record.definition, 'nl');
  return {
    id,
    uri,
    type,
    label: labelOf(record) ?? id,
    labels: { nl: languageValue(record.prefLabel, 'nl'), en: languageValue(record.prefLabel, 'en') },
    ...(definition ? { definition: definition.length > 400 ? `${definition.slice(0, 400)}…` : definition } : {}),
    schemes: asArray(record.inScheme as Json[]).map(refOf),
    broader: asArray(record.broader as Json[]).map(refOf),
    narrower: asArray((type === 'ConceptScheme' ? record.hasTopConcept : record.narrower) as Json[]).map(refOf),
  };
}

const labelCache = new LruCache<string>(20_000, 6 * 60 * 60_000);

/** Preferred labels for concept ids (from the records; falls back to the search index). */
export async function conceptLabels(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const failed: string[] = [];
  await Promise.all(
    unique
      .filter((id) => labelCache.get(id) === undefined)
      .map(async (id) => {
        try {
          labelCache.set(id, (await conceptRecord(id)).label);
        } catch {
          failed.push(id);
        }
      }),
  );
  const fallback = failed.length ? await labelsFor('concepts', failed) : new Map<string, string | null>();
  return new Map(unique.map((id) => [id, labelCache.get(id) ?? fallback.get(id) ?? id]));
}

export interface ResolvedConcept {
  id: string;
  label: string;
  method: string;
  /** Other concepts with the same label (labels recur across vocabularies). */
  alternatives?: Array<ConceptRef & { vocabulary?: string; uses: number }>;
}

/**
 * A concept given as id, URI or label. The same label often occurs in several vocabularies
 * ("Militaire beroepen" in Beroepen and in the Japan Glossary); then the most used one is taken
 * and the others are reported.
 */
export async function resolveConceptInput(input: string): Promise<ResolvedConcept> {
  const parsed = parseId(input.trim());
  if (parsed?.kind === 'thesaurus') {
    const record = await conceptRecord(parsed.id);
    return { id: parsed.id, label: record.label, method: 'concept id' };
  }
  const key = input.trim().toLowerCase();
  const data = await esSearch<{ title: unknown }>('concepts', { size: 30, _source: ['title'], query: { match_phrase: { title: input } } });
  const exact = data.hits.hits.filter((hit) => splitTitles(hit._source.title).some((t) => t.toLowerCase() === key)).map((hit) => hit._id);
  if (exact.length <= 1) {
    const found = exact[0] ? { id: exact[0] } : await resolveConcept(input);
    if (!found) throw new Error(`No thesaurus concept found for "${input}". Use browse_concepts or search_reference_data (kinds: ["concepts"]) to find its id.`);
    const label = (await conceptLabels([found.id])).get(found.id) ?? found.id;
    return { id: found.id, label, method: 'label looked up in the thesaurus; check this is the intended concept' };
  }

  const [uses, records] = await Promise.all([conceptUses(exact), Promise.all(exact.map((id) => conceptRecord(id).catch(() => null)))]);
  const candidates = exact
    .map((id, i) => ({ id, label: records[i]?.label ?? id, vocabulary: records[i]?.schemes[0]?.label, uses: uses.get(id) ?? 0 }))
    .sort((a, b) => b.uses - a.uses);
  const [best, ...others] = candidates;
  return {
    id: best.id,
    label: best.label,
    method: `label matches ${candidates.length} concepts; took the most used one${best.vocabulary ? ` (vocabulary ${best.vocabulary})` : ''}. Pass an id from alternatives to use another`,
    alternatives: others,
  };
}

/** Persons + documents classified with each concept (narrower included), for choosing among homonyms. */
async function conceptUses(ids: string[]): Promise<Map<string, number>> {
  const filters = (make: (id: string) => Record<string, unknown>) => ({ filters: { filters: Object.fromEntries(ids.map((id) => [id, make(id)])) } });
  const responses = await esMsearch([
    { index: 'persons', body: { size: 0, aggs: { uses: filters((id) => ({ multi_match: { query: id, fields: ['occupations', 'statuses', 'identities'] } })) } } },
    {
      index: 'documents',
      body: {
        size: 0,
        aggs: {
          uses: filters((id) => ({
            bool: { should: [{ term: { annotatedText: `personId:${id}` } }, { match_phrase: { professionIdPaths: id } }, { match_phrase: { documentTypeIdPaths: id } }], minimum_should_match: 1 },
          })),
        },
      },
    },
  ]);
  return new Map(
    ids.map((id) => [id, responses.reduce((total, r) => total + Number((r as { aggregations?: Record<string, any> }).aggregations?.uses?.buckets?.[id]?.doc_count ?? 0), 0)]),
  );
}

/** The concept schemes (vocabularies) of the thesaurus, with the number of concepts in each. */
export async function conceptSchemes(): Promise<Array<ConceptRef & { identifier?: string; concepts: number; top_concepts: number }>> {
  const data = await esSearch('concepts', {
    size: 0,
    aggs: { facets: { nested: { path: 'facets' }, aggs: { roots: { terms: { field: 'facets.concept_hierarchy.tree', size: 100, include: '[^|]+' } } } } },
  });
  const buckets: Array<{ key: string; doc_count: number }> = data.aggregations?.facets?.roots?.buckets ?? [];
  return Promise.all(
    buckets.map(async (bucket) => {
      const record = await fetchJson<Json>(uriFor('thesaurus', bucket.key)).catch(() => null);
      return {
        id: bucket.key,
        label: (record && labelOf(record)) ?? bucket.key,
        ...(record?.identifier ? { identifier: String(record.identifier) } : {}),
        concepts: bucket.doc_count,
        top_concepts: asArray(record?.hasTopConcept).length,
      };
    }),
  );
}
