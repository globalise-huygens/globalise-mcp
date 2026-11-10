// The documents index stores each transcription as Elasticsearch "annotated text": every tagged
// span is written as [surface](key%3Avalue&key%3Avalue), for example
//   [Amsterdam](type%3APlace&placeId%3AGLOB2_937)
//   [Coopman](type%3APerson&personId%3A45598da5-...)   <- personId is a ROLE concept, not a person
// The annotated highlighter adds `_hit_term=...` to the spans that matched the query.

export interface Span {
  surface: string;
  types: string[];
  placeId?: string;
  /** Thesaurus concept for the role/profession of a person mention (not a person record). */
  roleId?: string;
  hit: boolean;
}

export type Segment = string | Span;

// Annotation targets always start with a known key, which tells them apart from literal
// square brackets in the transcription such as "[getekend klavertje]".
const SPAN_RE = /\[([^\]]*)\]\(((?:_hit_term=|type%3A)[^)]*)\)/g;

export function parseAnnotated(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(SPAN_RE)) {
    if (match.index > last) segments.push(text.slice(last, match.index));
    segments.push(parseSpan(match[1], match[2]));
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push(text.slice(last));
  return segments;
}

function parseSpan(surface: string, target: string): Span {
  const span: Span = { surface, types: [], hit: false };
  for (const part of target.split('&')) {
    if (part.startsWith('_hit_term=')) {
      span.hit = true;
      continue;
    }
    const decoded = safeDecode(part);
    const colon = decoded.indexOf(':');
    if (colon < 0) continue;
    const key = decoded.slice(0, colon);
    const value = decoded.slice(colon + 1);
    if (key === 'type') span.types.push(value);
    else if (key === 'placeId') span.placeId = value;
    else if (key === 'personId') span.roleId = value;
  }
  return span;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const plainText = (segments: Segment[]): string => segments.map((s) => (typeof s === 'string' ? s : s.surface)).join('');

/** Tag rendering for an LLM: concise, keeps ids that can be followed with get_record. */
function inlineTag(span: Span): string {
  const parts = [span.types.join('+')];
  if (span.placeId) parts.push(`place:${span.placeId}`);
  if (span.roleId) parts.push(`role:${span.roleId}`);
  return `[${span.surface}]{${parts.join(' ')}}`;
}

export type TextFormat = 'plain' | 'inline';

export function renderSegments(segments: Segment[], format: TextFormat, markHits = false): string {
  return segments
    .map((segment) => {
      if (typeof segment === 'string') return segment;
      const body = format === 'inline' ? inlineTag(segment) : segment.surface;
      return markHits && segment.hit ? `«${body}»` : body;
    })
    .join('');
}

/** Renders a highlighter fragment: matches are wrapped in «», tags kept compact. */
export function renderFragment(fragment: string, format: TextFormat = 'inline'): string {
  return collapseWhitespace(renderSegments(parseAnnotated(fragment), format, true));
}

export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

export interface EntitySummary {
  places: Array<{ placeId: string; surfaces: string[]; count: number }>;
  roles: Array<{ conceptId: string; surfaces: string[]; count: number }>;
  /** Person-name mentions tagged as Person without a role concept (named people). */
  personNames: Array<{ surface: string; count: number }>;
  annotationTypes: Record<string, number>;
}

/** Aggregates the tagged spans of a document: which places, roles and event types occur, and how often. */
export function summariseEntities(segments: Segment[], limit = 50): EntitySummary {
  const places = new Map<string, { surfaces: Set<string>; count: number }>();
  const roles = new Map<string, { surfaces: Set<string>; count: number }>();
  const names = new Map<string, number>();
  const types: Record<string, number> = {};

  for (const segment of segments) {
    if (typeof segment === 'string') continue;
    for (const type of segment.types) types[type] = (types[type] ?? 0) + 1;
    if (segment.placeId) bump(places, segment.placeId, segment.surface);
    if (segment.roleId) bump(roles, segment.roleId, segment.surface);
    else if (segment.types.includes('Person') && /^\p{Lu}/u.test(segment.surface) && segment.surface.includes(' ')) {
      const key = collapseWhitespace(segment.surface);
      names.set(key, (names.get(key) ?? 0) + 1);
    }
  }

  const ranked = (map: Map<string, { surfaces: Set<string>; count: number }>) =>
    [...map.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([id, v]) => ({ id, surfaces: [...v.surfaces].slice(0, 5), count: v.count }));

  return {
    places: ranked(places).map(({ id, ...rest }) => ({ placeId: id, ...rest })),
    roles: ranked(roles).map(({ id, ...rest }) => ({ conceptId: id, ...rest })),
    personNames: [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([surface, count]) => ({ surface, count })),
    annotationTypes: Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1])),
  };
}

function bump(map: Map<string, { surfaces: Set<string>; count: number }>, id: string, surface: string) {
  const entry = map.get(id) ?? { surfaces: new Set<string>(), count: 0 };
  entry.surfaces.add(collapseWhitespace(surface));
  entry.count += 1;
  map.set(id, entry);
}
