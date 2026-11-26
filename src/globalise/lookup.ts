// Labels for ids and ids for labels: the indexed fields mostly hold thesaurus and place ids,
// and typed field values (profession:koopman) need to be resolved to ids before searching.

import type { IndexKey } from '../config.ts';
import { LruCache } from '../util/cache.ts';
import { esSearch, splitTitles } from './es.ts';
import { parseId } from './ids.ts';
import { MAX_SPAN_PLACES, resolveRegion, type RegionSpec } from './places.ts';
import { type Chip, hasWildcard } from './query.ts';

const labelCache = new LruCache<string | null>(20_000, 6 * 60 * 60_000);

const TITLE_FIELD: Partial<Record<IndexKey, string>> = { persons: 'titles' };

/** Looks up display labels for ids in one index. Unknown ids map to null. */
export async function labelsFor(index: IndexKey, ids: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const missing = unique.filter((id) => labelCache.get(`${index}:${id}`) === undefined);
  const field = TITLE_FIELD[index] ?? 'title';
  for (let i = 0; i < missing.length; i += 500) {
    const batch = missing.slice(i, i + 500);
    const data = await esSearch<Record<string, unknown>>(index, { size: batch.length, _source: [field], query: { ids: { values: batch } } });
    for (const hit of data.hits.hits) labelCache.set(`${index}:${hit._id}`, splitTitles(hit._source[field])[0] ?? hit._id);
    for (const id of batch) if (labelCache.get(`${index}:${id}`) === undefined) labelCache.set(`${index}:${id}`, null);
  }
  return new Map(unique.map((id) => [id, labelCache.get(`${index}:${id}`) ?? null]));
}

/** All spellings recorded for a named entity, from its search index entry. */
export async function variantsFor(index: IndexKey, id: string): Promise<string[]> {
  const field = TITLE_FIELD[index] ?? 'title';
  const data = await esSearch<Record<string, unknown>>(index, { size: 1, _source: [field], query: { ids: { values: [id] } } });
  const hit = data.hits.hits[0];
  return hit ? splitTitles(hit._source[field]) : [];
}

/** Finds the thesaurus concept for a typed label (exact label preferred). */
export async function resolveConcept(value: string): Promise<{ id: string; label: string } | null> {
  const data = await esSearch<{ title: unknown }>('concepts', { size: 30, _source: ['title'], query: { match_phrase: { title: value } } });
  const key = value.trim().toLowerCase();
  const hits = data.hits.hits;
  const exact = hits.find((hit) => splitTitles(hit._source.title).some((t) => t.toLowerCase() === key));
  const best = exact ?? hits[0];
  return best ? { id: best._id, label: splitTitles(best._source.title)[0] ?? best._id } : null;
}

const NAMED_INDEX: Partial<Record<Chip['fieldKey'], IndexKey>> = {
  person: 'persons',
  ship: 'ships',
  organisation: 'organisations',
  polity: 'polities',
};

export interface Resolution {
  field: string;
  input: string;
  resolvedTo?: string;
  method: string;
  /** For regions: which places were used, and how. */
  region?: RegionSummary;
}

export interface RegionSummary {
  description: string;
  places_in_region: number;
  places_linked_in_text: number;
  /** The places mentioned in most documents (documents across the whole corpus). */
  top_linked_places: string[];
  overlaps_followed?: string[];
  notes?: string[];
}

/** Resolves a region to the place ids to search for, with an account for the user. */
export async function regionIds(spec: RegionSpec, field = 'region'): Promise<{ ids: string[]; resolution: Resolution }> {
  const region = await resolveRegion(spec);
  const ids = region.linked.map((n) => n.id);
  const summary: RegionSummary = {
    description: region.description,
    places_in_region: region.members.length,
    places_linked_in_text: ids.length,
    top_linked_places: region.linked.slice(0, 12).map((n) => `${n.label} (${n.id}): ${n.documents} documents`),
    ...(region.overlapsFollowed.length
      ? { overlaps_followed: region.overlapsFollowed.slice(0, 15).map((o) => `${o.from} overlaps ${o.to}`).concat(region.overlapsFollowed.length > 15 ? [`… ${region.overlapsFollowed.length - 15} more`] : []) }
      : {}),
    ...(region.notes.length ? { notes: region.notes } : {}),
  };
  if (!ids.length) {
    throw new Error(`The region ${region.description} contains ${region.members.length} place record(s), but none of them is linked to mentions in the text, so no document can match. Try a larger region or explore_places to see what it contains.`);
  }
  return {
    ids,
    resolution: {
      field,
      input: JSON.stringify(spec),
      resolvedTo: `${ids.length} place ids`,
      method: 'region → every place record inside it (part-of hierarchy and/or coordinates) → mentions linked to any of those ids in the text',
      region: summary,
    },
  };
}

/**
 * Fills in ids and spelling variants on chips, so that e.g. `profession:koopman` becomes a
 * concept id and `ship:gzm_ship0511` becomes every recorded name of that ship. Mutates the chips.
 * Returns a human-readable account of what was resolved and how, for transparency.
 */
export async function resolveChips(chips: Chip[]): Promise<Resolution[]> {
  const notes: Resolution[] = [];
  await Promise.all(
    chips.map(async (chip) => {
      if (chip.id || hasWildcard(chip.value)) return;
      const parsed = parseId(chip.value);
      const named = NAMED_INDEX[chip.fieldKey];

      if (chip.fieldKey === 'within') {
        const { ids, resolution } = await regionIds({ within: chip.value }, 'within');
        if (ids.length > MAX_SPAN_PLACES) {
          resolution.region!.notes = [...(resolution.region!.notes ?? []), `Large region (${ids.length} places): inside a proximity group only the ${MAX_SPAN_PLACES} most mentioned places are used.`];
        }
        chip.ids = ids;
        chip.id = chip.value;
        notes.push(resolution);
        return;
      }

      if (chip.fieldKey === 'place') {
        if (parsed?.kind === 'place') {
          chip.id = parsed.id;
          notes.push({ field: 'place', input: chip.value, resolvedTo: parsed.id, method: 'exact place id: matches every spelling tagged with this place in the text' });
        } else {
          notes.push({ field: 'place', input: chip.value, method: 'spelling match within text tagged as Place (no id): other spellings of the same place are missed; use search_reference_data to find the place id' });
        }
        return;
      }

      if (named) {
        if (parsed && parsed.kind !== 'thesaurus') {
          const variants = await variantsFor(named, parsed.id);
          if (variants.length) {
            chip.variants = variants;
            chip.id = parsed.id;
            notes.push({ field: chip.fieldKey, input: chip.value, resolvedTo: variants.join(' | '), method: 'record id → all recorded spellings, matched as phrases in the text (named entities are not linked by id in the text yet; homonyms will also match)' });
            return;
          }
        }
        notes.push({ field: chip.fieldKey, input: chip.value, method: 'literal phrase match in the text (no record id given): spelling variants and HTR errors are missed' });
        return;
      }

      if (['role', 'profession', 'concept', 'documenttype'].includes(chip.fieldKey)) {
        if (parsed?.kind === 'thesaurus') {
          chip.id = parsed.id;
          notes.push({ field: chip.fieldKey, input: chip.value, resolvedTo: parsed.id, method: 'thesaurus concept id' });
          return;
        }
        const concept = await resolveConcept(chip.value);
        if (concept) {
          chip.id = concept.id;
          notes.push({ field: chip.fieldKey, input: chip.value, resolvedTo: `${concept.label} (${concept.id})`, method: 'label looked up in the thesaurus; verify this is the intended concept' });
        } else {
          notes.push({ field: chip.fieldKey, input: chip.value, method: 'no thesaurus concept found for this label' });
        }
      }
    }),
  );
  return notes;
}
