// The query language of the GLOBALISE "search everything" prototype (globalise-search/unified),
// ported to TypeScript for the documents index. Pure functions: no network.
//
//   words, "exact phrases", wildcards (timmer*), fuzzy (timmerman~1)
//   AND / OR / NOT and parentheses
//   proximity: (amsterdam timmerman)~5, also with fields: (place:GLOB2_937 koopman)~10
//   fields: place: role: profession: concept: annotation: documenttype: title: settlement:
//           archive: inventory: year: person: ship: organisation: polity:

const TEXT = 'annotatedText';

export type FieldKey =
  | 'place'
  | 'person'
  | 'ship'
  | 'organisation'
  | 'polity'
  | 'role'
  | 'profession'
  | 'concept'
  | 'annotation'
  | 'documenttype'
  | 'title'
  | 'settlement'
  | 'archive'
  | 'inventory'
  | 'year';

const ALIASES: Record<string, FieldKey> = {
  place: 'place', location: 'place', plaats: 'place',
  person: 'person', name: 'person', personname: 'person', persoon: 'person',
  ship: 'ship', schip: 'ship',
  organisation: 'organisation', organization: 'organisation', org: 'organisation', group: 'organisation',
  polity: 'polity', rijk: 'polity',
  role: 'role', mention: 'role', rol: 'role',
  profession: 'profession', occupation: 'profession', beroep: 'profession',
  concept: 'concept', thesaurus: 'concept',
  annotation: 'annotation', ann: 'annotation', type: 'annotation', event: 'annotation', tag: 'annotation',
  documenttype: 'documenttype', doctype: 'documenttype',
  title: 'title', titel: 'title',
  settlement: 'settlement',
  archive: 'archive', ead: 'archive', series: 'archive',
  inventory: 'inventory', inv: 'inventory', invnr: 'inventory',
  year: 'year', date: 'year', jaar: 'year',
};

/** Fields whose clause goes in the scored part of the query (they say *where* in the text). */
const SCORED = new Set<FieldKey>(['place', 'person', 'ship', 'organisation', 'polity', 'role', 'annotation']);

export interface Chip {
  fieldKey: FieldKey;
  value: string;
  /** Resolved record or concept id, when known. */
  id?: string;
  /** Every recorded spelling of a named entity (persons, ships, organisations, polities). */
  variants?: string[];
}

export type ProxItem =
  | { kind: 'word'; text: string; fuzzy: string | null }
  | { kind: 'phrase'; text: string }
  | ({ kind: 'field' } & Chip);

export type Node =
  | { t: 'words'; words: string[] }
  | { t: 'field'; chip: Chip }
  | { t: 'prox'; slop: number; items: ProxItem[] }
  | { t: 'not'; inner: Node }
  | { t: 'and' | 'or'; parts: Node[] };

type Token =
  | { type: 'LPAREN' | 'RPAREN' | 'AND' | 'OR' | 'NOT' }
  | { type: 'PROX'; slop: number; items: ProxItem[] }
  | { type: 'WORD'; text: string }
  | { type: 'FIELD'; fieldKey: FieldKey; value: string };

export const ANNOTATION_TYPES = [
  'Person', 'Place', 'Group', 'HumanMadeObject', 'PersistentItem', 'Dimension', 'TimeSpan', 'Voyage', 'Move',
  'CorrespondenceEvent', 'Payment', 'Purchase', 'Acquisition', 'DeclarativeAcquisition', 'DeclarativeJoining',
  'DeclarativeLeaving', 'Production', 'Transformation', 'Attack', 'Destruction', 'IntentionalDestruction',
  'DestructivePhysicalModification', 'ExerciseOfAuthority', 'ActOfAuthority', 'SpeechAct', 'SymbolicAct',
  'PromissoryAgreement', 'Event', 'InternalChange', 'InternalState', 'PhysicalLocativeStatus',
  'SocialRelationStatus', 'OwnershipStatus', 'ObligationStatus', 'PromissoryStatus',
] as const;

// --- Tokenizer ----------------------------------------------------------------------------

function findMatchingParen(input: string, start: number): number {
  let depth = 0;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      i = end === -1 ? input.length : end;
    } else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readFieldValue(input: string, i: number): { fieldKey: FieldKey; value: string; next: number } | null {
  const fieldMatch = /^([A-Za-z]+)\s*:\s*/.exec(input.slice(i));
  const fieldKey = fieldMatch ? ALIASES[fieldMatch[1].toLowerCase()] : undefined;
  if (!fieldMatch || !fieldKey) return null;
  let j = i + fieldMatch[0].length;
  let value: string;
  if (input[j] === '"') {
    const end = input.indexOf('"', j + 1);
    value = end === -1 ? input.slice(j + 1) : input.slice(j + 1, end);
    j = end === -1 ? input.length : end + 1;
  } else {
    value = /^[^\s()]*/.exec(input.slice(j))?.[0] ?? '';
    j += value.length;
  }
  return { fieldKey, value, next: j };
}

function tokenizeProximityItems(input: string): ProxItem[] {
  const items: ProxItem[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i += 1;
      continue;
    }
    const field = readFieldValue(input, i);
    if (field) {
      items.push({ kind: 'field', fieldKey: field.fieldKey, value: field.value });
      i = field.next;
      continue;
    }
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      items.push({ kind: 'phrase', text: end === -1 ? input.slice(i + 1) : input.slice(i + 1, end) });
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    const raw = /^[^\s()]+/.exec(input.slice(i));
    if (!raw) {
      i += 1;
      continue;
    }
    i += raw[0].length;
    const fuzzy = /^(.+?)~(\d*)$/.exec(raw[0]);
    items.push(fuzzy ? { kind: 'word', text: fuzzy[1], fuzzy: fuzzy[2] || 'AUTO' } : { kind: 'word', text: raw[0], fuzzy: null });
  }
  return items;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) i += 1;
    else if (ch === '(') {
      const close = findMatchingParen(input, i);
      const slop = close === -1 ? null : /^~(\d+)/.exec(input.slice(close + 1));
      if (slop) {
        tokens.push({ type: 'PROX', slop: Number(slop[1]), items: tokenizeProximityItems(input.slice(i + 1, close)) });
        i = close + 1 + slop[0].length;
      } else {
        tokens.push({ type: 'LPAREN' });
        i += 1;
      }
    } else if (ch === ')') {
      tokens.push({ type: 'RPAREN' });
      i += 1;
    } else if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      tokens.push({ type: 'WORD', text: end === -1 ? `${input.slice(i)}"` : input.slice(i, end + 1) });
      i = end === -1 ? input.length : end + 1;
    } else {
      const field = readFieldValue(input, i);
      const keyword = field ? null : /^(AND|OR|NOT)(?![A-Za-z0-9_])/.exec(input.slice(i));
      if (field) {
        tokens.push({ type: 'FIELD', fieldKey: field.fieldKey, value: field.value });
        i = field.next;
      } else if (keyword) {
        tokens.push({ type: keyword[1] as 'AND' | 'OR' | 'NOT' });
        i += keyword[0].length;
      } else {
        const word = /^[^\s()]+/.exec(input.slice(i))?.[0] ?? input[i];
        tokens.push({ type: 'WORD', text: word });
        i += word.length;
      }
    }
  }
  return tokens;
}

// --- Parser: orExpr := andExpr (OR andExpr)*   andExpr := notExpr (AND? notExpr)* ----------

export function parse(input: string): Node | null {
  const tokens = tokenize(input || '');
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  function primary(): Node | null {
    const token = peek();
    if (!token) return null;
    pos += 1;
    switch (token.type) {
      case 'LPAREN': {
        const inner = or();
        if (peek()?.type === 'RPAREN') pos += 1;
        return inner;
      }
      case 'PROX':
        return { t: 'prox', slop: token.slop, items: token.items };
      case 'FIELD':
        return token.value ? { t: 'field', chip: { fieldKey: token.fieldKey, value: token.value } } : null;
      case 'WORD': {
        const words = [token.text];
        let next = peek();
        while (next?.type === 'WORD') {
          words.push(next.text);
          pos += 1;
          next = peek();
        }
        return { t: 'words', words };
      }
      default:
        return null; // stray ")" or operator
    }
  }

  function not(): Node | null {
    if (peek()?.type === 'NOT') {
      pos += 1;
      const inner = primary();
      return inner ? { t: 'not', inner } : null;
    }
    return primary();
  }

  function and(): Node | null {
    const parts = [not()].filter((p): p is Node => p !== null);
    while (peek() && peek()?.type !== 'OR' && peek()?.type !== 'RPAREN') {
      if (peek()?.type === 'AND') pos += 1;
      const next = not();
      if (next) parts.push(next);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : { t: 'and', parts };
  }

  function or(): Node | null {
    const parts = [and()].filter((p): p is Node => p !== null);
    while (peek()?.type === 'OR') {
      pos += 1;
      const next = and();
      if (next) parts.push(next);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : { t: 'or', parts };
  }

  let tree = or();
  while (pos < tokens.length) {
    pos += 1;
    const rest = or();
    if (rest) tree = tree ? { t: 'and', parts: [tree, rest] } : rest;
  }
  return tree;
}

/** Every field:value in a tree, including inside proximity groups (objects are shared, so resolving mutates the tree). */
export function collectChips(tree: Node | null, out: Chip[] = []): Chip[] {
  if (!tree) return out;
  if (tree.t === 'field') out.push(tree.chip);
  else if (tree.t === 'not') collectChips(tree.inner, out);
  else if (tree.t === 'and' || tree.t === 'or') tree.parts.forEach((part) => collectChips(part, out));
  else if (tree.t === 'prox') tree.items.forEach((item) => item.kind === 'field' && out.push(item));
  return out;
}

// --- Helpers ------------------------------------------------------------------------------

export const hasWildcard = (value: string): boolean => /[*?]/.test(value);
const escapeWildcard = (value: string) => value.replace(/([\\*?])/g, '\\$1');
const containsPattern = (value: string) => (hasWildcard(value) ? value : `*${escapeWildcard(value)}*`);

// Keeps wildcards, fuzziness and quotes, but stops ":" being read as Lucene field syntax:
// "Comp:s" (Compagnies) is a very common abbreviation in the corpus.
function escapeLucene(word: string): string {
  if (word.startsWith('"')) return word;
  return word.replace(/([+\-!(){}[\]^:/\\&|<>=])/g, '\\$1');
}

const queryString = (words: string[]) => ({
  query_string: { query: words.map(escapeLucene).join(' '), default_field: TEXT, default_operator: 'AND' },
});

const analyzedWords = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}*?']+/u).filter(Boolean);

function wordSpan(word: string, fuzzy: string | null = null): Record<string, unknown> {
  const value = word.toLowerCase();
  if (fuzzy) return { span_multi: { match: { fuzzy: { [TEXT]: { value, fuzziness: fuzzy } } } } };
  if (hasWildcard(value)) return { span_multi: { match: { wildcard: { [TEXT]: { value } } } } };
  return { span_term: { [TEXT]: value } };
}

function phraseSpan(text: string): Record<string, unknown> | null {
  const words = analyzedWords(text);
  if (!words.length) return null;
  if (words.length === 1) return wordSpan(words[0]);
  return { span_near: { clauses: words.map((w) => wordSpan(w)), slop: 0, in_order: true } };
}

const anySpan = (spans: Record<string, unknown>[]) => (spans.length === 1 ? spans[0] : { span_or: { clauses: spans } });

/** Text as written, but only where it is tagged with this annotation (annotations share word positions). */
function taggedSpan(annotation: string, text: string) {
  const little = phraseSpan(text);
  return little ? { span_within: { big: { span_term: { [TEXT]: annotation } }, little } } : null;
}

const annotationTerm = (key: string, value: string) => ({ term: { [TEXT]: `${key}:${value}` } });

const should = (clauses: Record<string, unknown>[]) => (clauses.length === 1 ? clauses[0] : { bool: { should: clauses, minimum_should_match: 1 } });

export function canonicalAnnotationType(value: string): string | null {
  const lower = value.trim().toLowerCase();
  return ANNOTATION_TYPES.find((type) => type.toLowerCase() === lower) ?? null;
}

export function yearRange(value: string): [number, number] | null {
  const range = /^(\d{3,4})\s*-\s*(\d{3,4})$/.exec(value.trim());
  if (range) return [Number(range[1]), Number(range[2])];
  const single = /^(\d{3,4})$/.exec(value.trim());
  return single ? [Number(single[1]), Number(single[1])] : null;
}

export function dateOverlap(from?: number, to?: number): Record<string, unknown> | null {
  if (from === undefined && to === undefined) return null;
  const filter: Record<string, unknown>[] = [];
  if (to !== undefined) filter.push({ range: { startDate: { lte: `${to}-12-31` } } });
  if (from !== undefined) filter.push({ range: { endDate: { gte: `${from}-01-01` } } });
  return { bool: { filter } };
}

function nameVariants(chip: Chip): string[] {
  const list = chip.variants?.length ? chip.variants : [chip.value];
  return [...new Set(list.map((v) => v.trim()).filter(Boolean))];
}

/** Named people, ships, organisations and polities have no id in the text: match any recorded spelling. */
function namesClause(chip: Chip) {
  const variants = nameVariants(chip);
  if (variants.length === 1 && hasWildcard(variants[0])) {
    const little = phraseSpan(variants[0]);
    return little ? { span_within: { big: { span_term: { [TEXT]: 'type:Person' } }, little } } : { match_none: {} };
  }
  return should(variants.map((variant) => ({ match_phrase: { [TEXT]: variant } })));
}

type Mode = 'filter' | 'highlight';

/** The clause for one field:value. Returns null when the field doesn't constrain the text (highlight mode). */
export function fieldClause(chip: Chip, mode: Mode = 'filter'): Record<string, unknown> | null {
  const highlight = mode === 'highlight';
  switch (chip.fieldKey) {
    case 'place':
      return chip.id ? annotationTerm('placeId', chip.id) : taggedSpan('type:Place', chip.value) ?? { match_none: {} };
    case 'person':
    case 'ship':
    case 'organisation':
    case 'polity':
      return namesClause(chip);
    case 'role':
      return chip.id ? annotationTerm('personId', chip.id) : taggedSpan('type:Person', chip.value) ?? { match_none: {} };
    case 'profession':
      if (!chip.id) return taggedSpan('type:Person', chip.value) ?? { match_none: {} };
      return highlight ? annotationTerm('personId', chip.id) : { match_phrase: { professionIdPaths: chip.id } };
    case 'concept':
      if (!chip.id) return { match_none: {} };
      if (highlight) return annotationTerm('personId', chip.id);
      return should([
        annotationTerm('personId', chip.id),
        { match_phrase: { professionIdPaths: chip.id } },
        { match_phrase: { documentTypeIdPaths: chip.id } },
      ]);
    case 'annotation': {
      const type = canonicalAnnotationType(chip.value);
      return type ? annotationTerm('type', type) : { match_none: {} };
    }
    case 'documenttype':
      if (highlight) return null;
      return chip.id ? { match_phrase: { documentTypeIdPaths: chip.id } } : { match_none: {} };
    case 'title':
      return highlight ? null : { match: { title: { query: chip.value, operator: 'and' } } };
    case 'settlement':
      if (highlight) return null;
      return hasWildcard(chip.value)
        ? { wildcard: { settlement: { value: chip.value, case_insensitive: true } } }
        : { term: { settlement: { value: chip.value, case_insensitive: true } } };
    case 'archive':
      if (highlight) return null;
      return chip.id
        ? { term: { 'eadIdPaths.tree': chip.id } }
        : { wildcard: { archiveDescription: { value: containsPattern(chip.value), case_insensitive: true } } };
    case 'inventory':
      if (highlight) return null;
      return hasWildcard(chip.value) ? { wildcard: { inventoryNumber: { value: chip.value } } } : { term: { inventoryNumber: chip.value } };
    case 'year': {
      if (highlight) return null;
      const range = yearRange(chip.value);
      return range ? dateOverlap(range[0], range[1]) : { match_none: {} };
    }
    default:
      return null;
  }
}

function proxItemSpan(item: ProxItem): Record<string, unknown> | null {
  if (item.kind === 'word') return wordSpan(item.text, item.fuzzy);
  if (item.kind === 'phrase') return phraseSpan(item.text);
  const value = (item.value || '').trim();
  if (!value) return null;
  if (item.fieldKey === 'place') return item.id ? { span_term: { [TEXT]: `placeId:${item.id}` } } : taggedSpan('type:Place', value);
  if (item.fieldKey === 'role' || item.fieldKey === 'profession' || item.fieldKey === 'concept') {
    return item.id ? { span_term: { [TEXT]: `personId:${item.id}` } } : taggedSpan('type:Person', value);
  }
  if (item.fieldKey === 'annotation') {
    const type = canonicalAnnotationType(value);
    return type ? { span_term: { [TEXT]: `type:${type}` } } : null;
  }
  if (item.variants?.length) return anySpan(item.variants.map(phraseSpan).filter((s): s is Record<string, unknown> => s !== null));
  return phraseSpan(value);
}

export function compile(node: Node | null, mode: Mode = 'filter'): Record<string, unknown> | null {
  if (!node) return null;
  switch (node.t) {
    case 'words':
      if (node.words.length === 1 && node.words[0] === '*') return mode === 'highlight' ? null : { match_all: {} };
      return queryString(node.words);
    case 'field':
      return fieldClause(node.chip, mode);
    case 'prox': {
      const spans = node.items.map(proxItemSpan).filter((s): s is Record<string, unknown> => s !== null);
      if (spans.length < 2) return spans[0] ?? null;
      return { span_near: { clauses: spans, slop: node.slop, in_order: false } };
    }
    case 'not': {
      if (mode === 'highlight') return null;
      const inner = compile(node.inner, mode);
      return inner ? { bool: { must_not: [inner] } } : null;
    }
    case 'and':
    case 'or': {
      const clean = node.parts.map((part) => compile(part, mode)).filter((c): c is Record<string, unknown> => c !== null);
      if (!clean.length) return null;
      if (clean.length === 1) return clean[0];
      if (mode === 'highlight' || node.t === 'or') return { bool: { should: clean, minimum_should_match: 1 } };
      return { bool: { must: clean } };
    }
  }
}

/** The full documents query: the parsed expression plus separate structured filters. */
export function buildDocumentQuery(tree: Node | null, chips: Chip[], extraFilters: Record<string, unknown>[] = []): Record<string, unknown> {
  const must: Record<string, unknown>[] = [];
  const filter: Record<string, unknown>[] = [...extraFilters];
  const expression = compile(tree);
  if (expression) must.push(expression);
  for (const chip of chips) {
    const clause = fieldClause(chip);
    if (clause) (SCORED.has(chip.fieldKey) ? must : filter).push(clause);
  }
  if (!must.length && !filter.length) return { match_all: {} };
  return { bool: { ...(must.length ? { must } : {}), ...(filter.length ? { filter } : {}) } };
}

/** What to mark in the text: many filters (dates, profession paths) say nothing about where in the text to look. */
export function buildHighlightQuery(tree: Node | null, chips: Chip[]): Record<string, unknown> | null {
  const clauses: Record<string, unknown>[] = [];
  const expression = compile(tree, 'highlight');
  if (expression) clauses.push(expression);
  for (const chip of chips) {
    const clause = fieldClause(chip, 'highlight');
    if (clause) clauses.push(clause);
  }
  if (!clauses.length) return null;
  return clauses.length === 1 ? clauses[0] : { bool: { should: clauses, minimum_should_match: 1 } };
}
