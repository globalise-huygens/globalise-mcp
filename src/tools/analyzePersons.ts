import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, INDICES } from '../config.ts';
import { conceptLabels, conceptRecord, resolveConceptInput, type ResolvedConcept } from '../globalise/concepts.ts';
import { esSearch, splitTitles } from '../globalise/es.ts';
import { objectCardUrl, uriFor } from '../globalise/ids.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';

const DIMENSIONS = ['occupation', 'status', 'identity'] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** Keyword field with every concept on the person's paths (so a term query includes narrower concepts). */
const KEYWORD: Record<Dimension, string> = { occupation: 'occupations', status: 'statuses', identity: 'identities' };
const TREE: Record<Dimension, string> = { occupation: 'occupationIdPaths.tree', status: 'statusIdPaths.tree', identity: 'identityIdPaths.tree' };

type Args = {
  group_by?: Dimension;
  under?: string;
  cross_with?: Dimension;
  cross_under?: string;
  occupation?: string[];
  status?: string[];
  identity?: string[];
  name?: string;
  top?: number;
  cross_top?: number;
  sample?: number;
};

const escapeWildcard = (value: string) => value.replace(/([\\*?])/g, '\\$1');
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export const PERSONS_CAVEAT =
  'Person records are reference data, not a census: most (about 670,000 with status "Contractant") are Company employees from muster-roll data, so counts show who the Company recorded and how it classified them. The index has no dates, so periods cannot be compared here; dates are in the individual records (get_record).';

export function registerAnalyzePersons(server: McpServer) {
  server.registerTool(
    'analyze_persons',
    {
      title: 'Analyse person records by occupation, status or identity',
      description:
        'Counts the GLOBALISE person records (about 730,000) by thesaurus classification: occupation, status or identity. Filter by classifications and/or name, group by the concepts directly below a concept (under; default: the top level), and optionally cross-tabulate with a second dimension. Drill down by passing a bucket id as under. Use browse_concepts to see the hierarchy. Returns counts, shares, how many persons fall outside the listed groups, and sample persons to check.',
      inputSchema: {
        group_by: z.enum(DIMENSIONS).default('occupation').describe('Classification to count by.'),
        under: z.string().optional().describe('Concept id or label: group by its narrower concepts (e.g. "Militaire beroepen"). Default: the top level of the group_by hierarchy.'),
        cross_with: z.enum(DIMENSIONS).optional().describe('Second classification to break each group down by.'),
        cross_under: z.string().optional().describe('Concept id or label for the cross_with groups (its narrower concepts). Default: the top level.'),
        occupation: z.array(z.string()).max(10).optional().describe('Only persons with any of these occupations (concept ids or labels; narrower concepts included).'),
        status: z.array(z.string()).max(10).optional().describe('Only persons with any of these statuses.'),
        identity: z.array(z.string()).max(10).optional().describe('Only persons with any of these identities.'),
        name: z.string().max(200).optional().describe('Only persons with a recorded name containing these words (wildcards allowed).'),
        top: z.number().int().min(3).max(100).default(25).describe('Groups to return.'),
        cross_top: z.number().int().min(1).max(20).default(5).describe('Cross-tabulated groups per group.'),
        sample: z.number().int().min(0).max(20).default(5).describe('Sample persons matching the filters, to check against their records.'),
      },
      annotations: { ...READ_ONLY, title: 'Analyse persons' },
    },
    safe(async (args: Args) => {
      const groupBy = args.group_by ?? 'occupation';
      const top = args.top ?? 25;
      const resolutions: Resolution[] = [];

      const filter: Record<string, unknown>[] = [];
      for (const dim of DIMENSIONS) {
        const inputs = args[dim] ?? [];
        if (!inputs.length) continue;
        const resolved = await Promise.all(inputs.map(resolveConceptInput));
        resolved.forEach((r, i) => resolutions.push(resolution(dim, inputs[i], r)));
        filter.push({ terms: { [KEYWORD[dim]]: resolved.map((r) => r.id) } });
      }
      for (const word of (args.name ?? '').trim().split(/\s+/).filter(Boolean)) {
        filter.push({ wildcard: { titles: { value: /[*?]/.test(word) ? word : `*${escapeWildcard(word)}*`, case_insensitive: true } } });
      }
      // Grouping under a concept counts only the persons classified under it, so shares are within it.
      const under = args.under ? await underConcept(groupBy, args.under, resolutions) : undefined;
      if (under) filter.push({ term: { [KEYWORD[groupBy]]: under.id } });
      const query = filter.length ? { bool: { filter } } : { match_all: {} };

      const groups = await groupsFor(groupBy, under, query);
      const crossUnder = args.cross_with && args.cross_under ? await underConcept(args.cross_with, args.cross_under, resolutions) : undefined;
      const cross = args.cross_with ? await groupsFor(args.cross_with, crossUnder, query) : null;

      // A terms aggregation needs a non-empty include list; this placeholder matches nothing.
      const include = (ids: string[]) => (ids.length ? ids : ['none']);
      const data = await esSearch<{ titles?: unknown }>('persons', {
        size: args.sample ?? 5,
        _source: ['titles'],
        track_total_hits: true,
        query,
        aggs: {
          groups: {
            terms: { field: KEYWORD[groupBy], include: include(groups.ids), size: Math.max(groups.ids.length, 1) },
            ...(cross && args.cross_with
              ? { aggs: { cross: { terms: { field: KEYWORD[args.cross_with], include: include(cross.ids), size: Math.min(args.cross_top ?? 5, Math.max(cross.ids.length, 1)) } } } }
              : {}),
          },
          in_any_group: { filter: { terms: { [KEYWORD[groupBy]]: groups.ids } } },
          with_any_value: { filter: { exists: { field: KEYWORD[groupBy] } } },
        },
      });

      const total = data.hits.total.value;
      const aggs = data.aggregations ?? {};
      type Bucket = { key: string; doc_count: number; cross?: { buckets: Array<{ key: string; doc_count: number }> } };
      const buckets: Bucket[] = aggs.groups?.buckets ?? [];
      const crossIds = buckets.flatMap((b) => b.cross?.buckets.map((c) => c.key) ?? []);
      const labels = await conceptLabels([...buckets.map((b) => b.key), ...crossIds]);
      for (const ref of [...groups.known, ...(cross?.known ?? [])]) labels.set(ref.id, ref.label);
      const inAny = aggs.in_any_group?.doc_count ?? 0;
      const withValue = aggs.with_any_value?.doc_count ?? 0;

      const notes: string[] = ['A person can be in several groups (several occupations, or one concept on several paths), so shares can add up to more than 100%.'];
      if (total && !withValue) notes.push(`None of the matching persons has a ${groupBy} classification. Try another group_by.`);
      if (cross && args.cross_with && !cross.ids.length) notes.push(`None of the matching persons has a ${args.cross_with} classification, so there is no cross-tabulation.`);
      if (!total && under) notes.push(`No matching person has ${under.label} as ${groupBy}. It may belong to another dimension: try group_by "status" or "identity", or check it with browse_concepts.`);
      if (under && total > inAny) notes.push(`persons_not_in_listed_groups are classified as ${under.label} itself, without a narrower concept.`);

      return json({
        persons_matching: total,
        group_by: groupBy,
        groups_from: under ? `narrower concepts of ${under.label} (${under.id}); only persons classified under it are counted` : `top level of the ${groupBy} hierarchy`,
        groups: buckets
          .sort((a, b) => b.doc_count - a.doc_count)
          .slice(0, top)
          .map((b) => ({
            id: b.key,
            label: labels.get(b.key) ?? b.key,
            persons: b.doc_count,
            share_percent: percent(b.doc_count, total),
            ...(b.cross ? { [`by_${args.cross_with}`]: b.cross.buckets.map((c) => ({ id: c.key, label: labels.get(c.key) ?? c.key, persons: c.doc_count, share_of_group_percent: percent(c.doc_count, b.doc_count) })) } : {}),
          })),
        groups_with_persons: buckets.length,
        groups_listed_in_thesaurus: groups.ids.length,
        persons_in_listed_groups: inAny,
        persons_not_in_listed_groups: total - inAny,
        persons_without_any_value: total - withValue,
        ...(cross ? { cross_groups_from: crossUnder ? `narrower concepts of ${crossUnder.label} (${crossUnder.id})` : `top level of the ${args.cross_with} hierarchy` } : {}),
        ...(resolutions.length ? { resolved: resolutions } : {}),
        sample_persons: data.hits.hits.map((h) => ({ id: h._id, names: splitTitles(h._source.titles), object_card_url: objectCardUrl(uriFor('person', h._id)) })),
        notes,
        drill_down: 'Pass a group id as under (same group_by) to break it down further; open sample persons with get_record to check how they were classified and from which source.',
        provenance: provenance(
          [`${config.searchBase}/${INDICES.persons}/_search`],
          [PERSONS_CAVEAT, CAVEATS.referenceData],
          [data.hits.hits[0]?._index ?? (await indexVersion('persons'))],
        ),
      });
    }),
  );
}

type Resolution = { field: string; input: string; resolved_to: string; method: string; alternatives?: ResolvedConcept['alternatives'] };

const resolution = (field: string, input: string, r: ResolvedConcept): Resolution => ({
  field,
  input,
  resolved_to: `${r.label} (${r.id})`,
  method: r.method,
  ...(r.alternatives?.length ? { alternatives: r.alternatives } : {}),
});

type Under = { id: string; label: string; narrower: Array<{ id: string; label: string }> };

async function underConcept(dim: Dimension, input: string, resolutions: Resolution[]): Promise<Under> {
  const resolved = await resolveConceptInput(input);
  resolutions.push(resolution(`${dim} groups`, input, resolved));
  const record = await conceptRecord(resolved.id);
  if (record.type === 'ConceptScheme') throw new Error(`${resolved.label} is a whole vocabulary, not a concept. Leave under empty for the top level, or pick one of its concepts with browse_concepts.`);
  if (!record.narrower.length) throw new Error(`${resolved.label} (${resolved.id}) has no narrower concepts to group by. Filter on it instead (${dim}: ["${resolved.id}"]).`);
  return { id: resolved.id, label: resolved.label, narrower: record.narrower };
}

/** The concepts to group by: the narrower concepts of `under`, or the top level used in the data. */
async function groupsFor(dim: Dimension, under: Under | undefined, query: Record<string, unknown>): Promise<{ ids: string[]; known: Array<{ id: string; label: string }> }> {
  if (under) return { ids: under.narrower.map((n) => n.id), known: under.narrower };
  const data = await esSearch('persons', { size: 0, query, aggs: { roots: { terms: { field: TREE[dim], size: 200, include: '[^|]+' } } } });
  return { ids: (data.aggregations?.roots?.buckets ?? []).map((b: { key: string }) => b.key), known: [] };
}
