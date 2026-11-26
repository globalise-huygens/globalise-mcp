import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, INDICES } from '../config.ts';
import { conceptRecord, conceptSchemes, resolveConceptInput, type ConceptRef } from '../globalise/concepts.ts';
import { esMsearch } from '../globalise/es.ts';
import { objectCardUrl, uriFor } from '../globalise/ids.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';

type Args = { concept?: string; offset?: number; limit?: number };

/** Most concepts have tens of narrower concepts; beyond this, counts are only fetched for the page shown. */
const MAX_COUNTED = 300;

type Usage = {
  concepts_below?: number;
  persons?: { occupation?: number; status?: number; identity?: number };
  documents?: { role_tag?: number; profession?: number; document_type?: number };
};

export function registerBrowseConcepts(server: McpServer) {
  server.registerTool(
    'browse_concepts',
    {
      title: 'Browse the thesaurus hierarchy',
      description:
        'Shows the Globalise thesaurus as a tree. Without concept: the vocabularies (occupations, statuses, ethnic/religious/caste categories, commodities, document types, place types, ...). With a concept (id or label) or vocabulary id: its labels, definition, broader concepts and narrower concepts, each with how often it is used: persons with it as occupation/status/identity, and documents with it as role tag, profession or document type (narrower concepts included, except role tags). Use the ids in analyze_persons (under, filters), search_documents and analyze_distribution.',
      inputSchema: {
        concept: z.string().optional().describe('Concept or vocabulary id, URI or label (e.g. "Militaire beroepen", "soldaat"). Empty: list the vocabularies.'),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(40).describe('Narrower concepts to return.'),
      },
      annotations: { ...READ_ONLY, title: 'Browse concepts' },
    },
    safe(async (args: Args) => {
      if (!args.concept?.trim()) {
        const schemes = await conceptSchemes();
        return json({
          vocabularies: schemes.sort((a, b) => b.concepts - a.concepts),
          next: 'Call browse_concepts with a vocabulary id to see its top concepts.',
          provenance: provenance([`${config.searchBase}/${INDICES.concepts}/_search`], [CAVEATS.referenceData], [await indexVersion('concepts')]),
        });
      }

      const resolved = await resolveConceptInput(args.concept);
      const record = await conceptRecord(resolved.id);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 40;

      // Count usage for all narrower concepts when there are not too many, so they can be sorted by use.
      const countAll = record.narrower.length <= MAX_COUNTED;
      const toCount = countAll ? record.narrower : record.narrower.slice(offset, offset + limit);
      const usage = await usageOf([{ id: record.id, label: record.label }, ...toCount]);
      const weight = (u: Usage | undefined) => sum(u?.persons) + sum(u?.documents);
      const narrower = toCount
        .map((n) => ({ id: n.id, label: n.label, ...usage.get(n.id) }))
        .sort((a, b) => (countAll ? weight(b) - weight(a) : 0) || a.label.localeCompare(b.label));
      const page = countAll ? narrower.slice(offset, offset + limit) : narrower;

      return json({
        concept: {
          id: record.id,
          type: record.type === 'ConceptScheme' ? 'vocabulary' : 'concept',
          label: record.label,
          labels: record.labels,
          ...(record.definition ? { definition: record.definition } : {}),
          vocabularies: record.schemes,
          broader: record.broader,
          object_card_url: objectCardUrl(uriFor('thesaurus', record.id)),
          usage: usage.get(record.id),
        },
        ...(resolved.method !== 'concept id' ? { resolved: { input: args.concept, to: `${resolved.label} (${resolved.id})`, method: resolved.method, ...(resolved.alternatives?.length ? { alternatives: resolved.alternatives } : {}) } } : {}),
        [record.type === 'ConceptScheme' ? 'top_concepts' : 'narrower']: page,
        narrower_total: record.narrower.length,
        offset,
        order: countAll ? 'most used first (persons + documents)' : 'thesaurus order; too many to sort by use',
        notes: [
          'Person and document counts include narrower concepts, except role_tag, which counts documents tagging exactly this concept. Omitted counts are zero.',
          'A concept can sit under several broader concepts, so counts of siblings can overlap.',
        ],
        provenance: provenance(
          [record.uri, `${config.searchBase}/${INDICES.persons}/_search`, `${config.searchBase}/${INDICES.documents}/_search`],
          [CAVEATS.referenceData, CAVEATS.roles, 'Document counts are numbers of documents, not of mentions.'],
          [await indexVersion('concepts'), await indexVersion('persons'), await indexVersion('documents')],
        ),
      });
    }),
  );
}

const sum = (counts: Record<string, number | undefined> | undefined) => Object.values(counts ?? {}).reduce<number>((a, b) => a + (b ?? 0), 0);

/** Usage counts for many concepts in three requests (one per index), as filters aggregations. */
async function usageOf(concepts: ConceptRef[]): Promise<Map<string, Usage>> {
  const filters = (make: (id: string) => Record<string, unknown>) => ({ filters: { filters: Object.fromEntries(concepts.map((c) => [c.id, make(c.id)])) } });
  const [conceptCounts, personCounts, documentCounts] = await esMsearch([
    {
      index: 'concepts',
      body: { size: 0, aggs: { below: filters((id) => ({ nested: { path: 'facets', query: { match_phrase: { 'facets.concept_hierarchy': id } } } })) } },
    },
    {
      index: 'persons',
      body: {
        size: 0,
        aggs: {
          occupation: filters((id) => ({ term: { occupations: id } })),
          status: filters((id) => ({ term: { statuses: id } })),
          identity: filters((id) => ({ term: { identities: id } })),
        },
      },
    },
    {
      index: 'documents',
      body: {
        size: 0,
        aggs: {
          role_tag: filters((id) => ({ term: { annotatedText: `personId:${id}` } })),
          profession: filters((id) => ({ match_phrase: { professionIdPaths: id } })),
          document_type: filters((id) => ({ match_phrase: { documentTypeIdPaths: id } })),
        },
      },
    },
  ]);
  for (const response of [conceptCounts, personCounts, documentCounts]) {
    if (!response || 'error' in response) throw new Error(`Counting concept usage failed: ${JSON.stringify((response as { error?: unknown })?.error ?? 'no response').slice(0, 300)}`);
  }

  const count =(response: unknown, agg: string, id: string): number | undefined => {
    const value = (response as { aggregations?: Record<string, any> })?.aggregations?.[agg]?.buckets?.[id]?.doc_count;
    return typeof value === 'number' && value > 0 ? value : undefined;
  };
  const compact = <T extends Record<string, number | undefined>>(o: T) => {
    const kept = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    return Object.keys(kept).length ? (kept as T) : undefined;
  };

  return new Map(
    concepts.map((c) => {
      // The concept itself is in its own hierarchy path, so subtract it.
      const below = count(conceptCounts, 'below', c.id);
      const usage: Usage = {
        ...(below && below > 1 ? { concepts_below: below - 1 } : {}),
        persons: compact({ occupation: count(personCounts, 'occupation', c.id), status: count(personCounts, 'status', c.id), identity: count(personCounts, 'identity', c.id) }),
        documents: compact({ role_tag: count(documentCounts, 'role_tag', c.id), profession: count(documentCounts, 'profession', c.id), document_type: count(documentCounts, 'document_type', c.id) }),
      };
      if (!usage.persons) delete usage.persons;
      if (!usage.documents) delete usage.documents;
      return [c.id, usage];
    }),
  );
}
