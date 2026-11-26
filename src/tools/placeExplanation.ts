// Every answer that involves places says, in a fixed block, which place data and which mentions
// the search took into account, what it left out, and the limitations that apply. The model is
// told (server instructions, workflow) to pass this on to the user.

import { config } from '../config.ts';
import { placeGraph, regionOf, type PlaceGraph, type PlaceNode, type RegionSpec } from '../globalise/places.ts';
import type { Chip } from '../globalise/query.ts';

const BIAS_PAGE = `${config.websiteBase}/research-responsibly/ethics/bias-and-limitations.md`;

export const PLACE_LIMITATIONS = {
  linking:
    'Place mentions are linked to place records automatically. Mentions that were not linked (HTR misreadings, unknown spellings, places without a record) are missed; wrong links (a homonym, an adjective such as "Portugese", a misread word) are included.',
  meaning: 'A place tag says a place name is written there, not what it means in context: "Malabar" or "Ceylon" can stand for the Company government, the people or the ruler.',
  coverage: 'Places are mentioned very unevenly: the archive was written by and for the Company, so its own settlements dominate. Compare counts with the place\'s corpus count (per 1000), not raw numbers.',
  points: 'Coordinates are a single point per place, sometimes approximate; there are no boundaries. A box or radius includes a whole island, coast or kingdom only if its one point falls inside.',
  noCoordinates: 'Places without coordinates can never fall inside a box or radius.',
  hierarchy: '"Part of" relations are recorded for only some places and mix historical units (kingdoms, Company territories) with modern administrative regions; places not assigned to a region are missed by "within".',
  overlaps: 'Following overlapping records (city, kingdom and Company settlement of one name) can widen a region beyond what the name suggests.',
  writing: 'The place of writing (settlement) is plain text, inferred for most documents and empty for many; it is not linked to place records, so it is matched by spelling.',
} as const;

type Scope = 'mentions' | 'place_of_writing' | 'either';

export interface PlaceExplanationInput {
  chips: Chip[];
  region?: RegionSpec;
  scope?: Scope;
  /** Places of writing matched for a region (place_of_writing / either). */
  regionSettlements?: string[];
}

const name = (graph: PlaceGraph, id: string) => `${graph.nodes.get(id)?.label ?? id} (${id})`;

/** The explanation block, or null when the search involves no places at all. */
export async function explainPlaces(input: PlaceExplanationInput): Promise<Record<string, unknown> | null> {
  const placeChips = input.chips.filter((c) => c.fieldKey === 'place');
  const withinChips = input.chips.filter((c) => c.fieldKey === 'within' && c.id !== 'region');
  const settlementChips = input.chips.filter((c) => c.fieldKey === 'settlement');
  const hasRegion = !!input.region && !!(input.region.within || input.region.bbox || input.region.near);
  if (!placeChips.length && !withinChips.length && !settlementChips.length && !hasRegion) return null;

  const graph = await placeGraph().catch(() => null);
  const used: Record<string, unknown>[] = [];
  const notUsed = new Set<string>();
  const limitations = new Set<string>([PLACE_LIMITATIONS.linking, PLACE_LIMITATIONS.meaning, PLACE_LIMITATIONS.coverage]);

  for (const chip of placeChips) {
    const node = chip.id ? graph?.nodes.get(chip.id) : undefined;
    if (chip.id) {
      used.push({
        criterion: `place:${chip.id}`,
        place: graph ? name(graph, chip.id) : chip.id,
        matches: 'mentions linked to this exact place record, in any spelling',
        ...(node ? { corpus_documents_mentioning_it: node.documents } : {}),
        ...(node && node.documents === 0 ? { warning: zeroLinkedHint(graph!, node) } : {}),
      });
      if (node?.children.length) notUsed.add(`The ${node.children.length} place(s) recorded as part of ${name(graph!, node.id)} (use region={"within":"${node.id}"} or within:${node.id} to include them).`);
      if (node?.overlaps.length) notUsed.add(`Overlapping records of the same name: ${node.overlaps.map((o) => name(graph!, o)).join(', ')}.`);
      notUsed.add('Mentions of the place that were not linked, or were linked to another record.');
    } else {
      used.push({ criterion: `place:${chip.value}`, matches: 'words with this spelling (wildcards allowed) inside a Place tag; no place record involved' });
      notUsed.add(`Other spellings of the place, and untagged occurrences of "${chip.value}". Resolve the place to an id with search_reference_data for complete results.`);
    }
  }

  const describeRegion = (spec: RegionSpec, criterion: string, scope: Scope) => {
    if (!graph) return;
    const region = regionOf(graph, spec);
    const geographic = !!(spec.bbox || spec.near);
    const unlinked = region.members.length - region.linked.length;
    const entry: Record<string, unknown> = {
      criterion,
      region: region.description,
      built_from: [spec.within ? '"part of" relations' : null, spec.within && spec.follow_overlaps !== false ? 'overlapping records' : null, geographic ? 'coordinates' : null].filter(Boolean).join(', '),
      applies_to: scope === 'mentions' ? 'places mentioned in the text' : scope === 'place_of_writing' ? 'the place of writing' : 'places mentioned in the text, or the place of writing',
      place_records_in_region: region.members.length,
      ...(scope !== 'place_of_writing'
        ? {
            places_searched_for: region.linked.length,
            place_records_never_linked_in_text: unlinked,
            most_mentioned_places_used: region.linked.slice(0, 10).map((n) => `${name(graph, n.id)}: ${n.documents} documents in the corpus`),
          }
        : {}),
      ...(region.overlapsFollowed.length
        ? { overlaps_followed: region.overlapsFollowed.length, overlap_examples: region.overlapsFollowed.slice(0, 5).map((o) => `${o.from} overlaps ${o.to}`) }
        : {}),
      ...(scope !== 'mentions' && input.regionSettlements ? { places_of_writing_matched: input.regionSettlements.length ? input.regionSettlements : 'none' } : {}),
      ...(region.notes.length ? { notes: region.notes } : {}),
    };
    used.push(entry);
    if (unlinked && scope !== 'place_of_writing') notUsed.add(`${unlinked} place record(s) in the region that no text mention is linked to (e.g. atlas places); they cannot match.`);
    if (scope === 'mentions') notUsed.add('The place of writing (use region_applies_to="place_of_writing" or "either").');
    else if (scope === 'place_of_writing') notUsed.add('Mentions of places in the text (use region_applies_to="mentions" or "either").');
    if (geographic) {
      limitations.add(PLACE_LIMITATIONS.points);
      limitations.add(PLACE_LIMITATIONS.noCoordinates);
      notUsed.add('Places without coordinates, and large units (islands, coasts, kingdoms) whose single point lies outside the box or radius.');
    }
    if (spec.within) {
      limitations.add(PLACE_LIMITATIONS.hierarchy);
      notUsed.add('Places inside the area that are not recorded as part of the region (compare with a bbox or radius).');
      if (spec.follow_overlaps !== false && region.overlapsFollowed.length) limitations.add(PLACE_LIMITATIONS.overlaps);
    }
    if (scope !== 'mentions') limitations.add(PLACE_LIMITATIONS.writing);
  };

  for (const chip of withinChips) describeRegion({ within: chip.value }, `within:${chip.value}`, 'mentions');
  if (hasRegion) describeRegion(input.region!, `region=${JSON.stringify(input.region)}`, input.scope ?? 'mentions');

  for (const chip of settlementChips) {
    used.push({ criterion: `settlement:${chip.value}`, matches: 'the place-of-writing field, exact spelling (case-insensitive; wildcards allowed); not linked to place records' });
    notUsed.add('Documents whose place of writing is spelled differently or not recorded.');
    limitations.add(PLACE_LIMITATIONS.writing);
  }

  return {
    taken_into_account: used,
    not_taken_into_account: [...notUsed],
    limitations: [...limitations],
    more: BIAS_PAGE,
    tell_the_user:
      'Explain to the user, in plain words, which places and which kind of mentions this search took into account (and which it did not), and the limitations above that matter for their question. Do this every time places or regions are involved.',
  };
}

function zeroLinkedHint(graph: PlaceGraph, node: PlaceNode): string {
  const linkedOverlaps = node.overlaps.map((o) => graph.nodes.get(o)).filter((n): n is PlaceNode => !!n && n.documents > 0);
  const alternatives = linkedOverlaps.length ? ` Overlapping record(s) that are linked: ${linkedOverlaps.map((n) => `${name(graph, n.id)} (${n.documents} documents)`).join(', ')}.` : '';
  const inside = node.children.length ? ` To search the places it contains, use within:${node.id}.` : '';
  return `No text mention is linked to this record, so this criterion matches nothing.${alternatives}${inside}`;
}

/** The block for answers that describe places rather than search documents (explore_places, search_reference_data). */
export function placeDataExplanation(geographic: boolean): Record<string, unknown> {
  return {
    limitations: [
      PLACE_LIMITATIONS.linking,
      'Document counts are documents whose text links a mention to that exact place id; places that are never linked (atlas places, modern administrative regions, most overlapping senses) show 0 even when the place is written about.',
      PLACE_LIMITATIONS.hierarchy,
      ...(geographic ? [PLACE_LIMITATIONS.points, PLACE_LIMITATIONS.noCoordinates] : []),
      PLACE_LIMITATIONS.coverage,
    ],
    more: BIAS_PAGE,
    tell_the_user: 'When you use these places or counts, tell the user what the place data is based on and these limitations.',
  };
}
