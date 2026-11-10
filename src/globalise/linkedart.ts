// Compact, bounded summaries of GLOBALISE JSON-LD records (Linked Art / CIDOC-CRM for entities
// and documents, SKOS for thesaurus concepts). Some records are several MB (a ship with all its
// voyages), so the summary is an outline with counts, and single properties can be paged.

import { config } from '../config.ts';
import { viewerUrlForScan } from './ids.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = <T>(v: T | T[] | null | undefined): T[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

const SKIP_KEYS = new Set(['@context', 'id', 'type', '_label', 'identified_by', 'prefLabel', 'altLabel', 'hiddenLabel']);

/** A string from a JSON-LD literal ("x", {"@value": "x"}, or a list of those). */
function literal(value: Json | undefined): string[] {
  return asArray(value as Json)
    .map((v) => (typeof v === 'string' ? v : isObj(v) && typeof v['@value'] === 'string' ? `${v['@value']}${v['@language'] ? ` @${v['@language']}` : ''}` : null))
    .filter((v): v is string => !!v);
}

export function labelOf(node: Json | undefined): string | null {
  if (!isObj(node)) return typeof node === 'string' ? node : null;
  const label = node._label;
  if (typeof label === 'string' && label) return label;
  if (Array.isArray(label)) {
    const strings = label.filter((l): l is string => typeof l === 'string' && !!l);
    if (strings.length) return strings.join(' | ');
  }
  const pref = literal(node.prefLabel);
  if (pref.length) return pref.join(' | ');
  const name = asArray(node.identified_by).find((i) => isObj(i) && typeof i.content === 'string');
  if (isObj(name)) return String(name.content);
  if (typeof node.content === 'string') return node.content;
  return null;
}

function typeOf(node: Obj): string {
  return asArray(node.type).filter((t): t is string => typeof t === 'string').join('/');
}

export function timespanText(node: Json | undefined): string | null {
  if (!isObj(node)) return null;
  const begin = (node.begin_of_the_begin ?? node.end_of_the_begin) as string | undefined;
  const end = (node.end_of_the_end ?? node.begin_of_the_end ?? node['crm:P82b_end_of_the_end']) as string | undefined;
  const day = (s: unknown) => (typeof s === 'string' ? s.slice(0, 10) : null);
  const b = day(begin);
  const e = day(end);
  if (b && e) return b === e ? b : `${b} – ${e}`;
  if (b || e) return b ? `from ${b}` : `until ${e}`;
  const name = asArray(node.identified_by).find((i) => isObj(i) && typeof i.content === 'string');
  return isObj(name) ? String(name.content) : null;
}

const isGlobaliseUri = (id: unknown): id is string => typeof id === 'string' && id.startsWith(config.dataBase);

/** Records worth following: not vocabulary types, annotation pages or fragments. */
const isEntityUri = (id: string): boolean =>
  !id.includes('/annotations:') && !id.includes('/type:') && !id.includes('#') && !id.endsWith('.annotations');

/** One line describing a node: Type "label" <id> (dates) [classifications]. */
export function oneLine(node: Json): string {
  if (!isObj(node)) return String(node);
  const parts: string[] = [];
  const type = typeOf(node);
  if (type) parts.push(type);
  const label = labelOf(node);
  if (label) parts.push(`"${truncate(label, 160)}"`);
  if (typeof node.id === 'string' && !node.id.startsWith('_:')) parts.push(`<${node.id}>`);
  const when = timespanText(node.timespan);
  if (when) parts.push(`(${when})`);
  const classes = asArray(node.classified_as).map(labelOf).filter(Boolean);
  if (classes.length) parts.push(`[${[...new Set(classes)].join('; ')}]`);
  if (typeof node.content === 'string' && node.content !== label) parts.push(`: ${truncate(node.content, 300)}`);
  if (typeof node.value === 'number' || typeof node.value === 'string') parts.push(`= ${node.value}${isObj(node.unit) ? ` ${labelOf(node.unit) ?? ''}` : ''}`);
  return parts.join(' ');
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface LinkedEntity {
  uri: string;
  type: string;
  label: string | null;
  /** Where in the record the link occurs, e.g. "moved_by" or "is_classificatory_subject_of > classified_as". */
  via: string;
}

/** Every distinct GLOBALISE entity referenced anywhere in the record, with the property path. */
export function linkedEntities(record: Obj, limit = 80): { items: LinkedEntity[]; total: number } {
  const seen = new Map<string, LinkedEntity>();
  const visit = (node: Json, path: string[], depth: number) => {
    if (depth > 12) return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, path, depth + 1));
      return;
    }
    if (!isObj(node)) return;
    if (path.length && isGlobaliseUri(node.id) && node.id !== record.id && isEntityUri(node.id)) {
      if (!seen.has(node.id)) {
        const label = labelOf(node);
        seen.set(node.id, { uri: node.id, type: typeOf(node), label: label ? truncate(label, 200) : null, via: path.join(' > ') });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '@context' || key === 'id') continue;
      visit(value, [...path, key], depth + 1);
    }
  };
  visit(record, [], 0);
  const all = [...seen.values()];
  return { items: all.slice(0, limit), total: all.length };
}

/** Bibliographic sources cited anywhere in the record (Linked Art "referred_to_by" / SKOS "source"). */
export function citedSources(record: Obj, limit = 30): string[] {
  const out = new Set<string>();
  const visit = (node: Json, depth: number) => {
    if (depth > 12 || out.size >= limit * 3) return;
    if (Array.isArray(node)) return node.forEach((child) => visit(child, depth + 1));
    if (!isObj(node)) return;
    if (node.type === 'LinguisticObject') {
      for (const ident of asArray(node.identified_by)) {
        if (isObj(ident) && typeof ident.content === 'string' && /\(|\d{4}|zotero|http/.test(ident.content)) out.add(ident.content);
      }
    }
    for (const [key, value] of Object.entries(node)) if (key !== '@context') visit(value, depth + 1);
  };
  visit(record, 0);
  literal(record.source).forEach((s) => out.add(s));
  literal(record.references).forEach((s) => out.add(s));
  return [...out].slice(0, limit).map(describeScanSource);
}

/** Sources that are scan filenames (nl-hana_1.04.02_6616_0299.jpg) become scan ids with a viewer link. */
function describeScanSource(source: string): string {
  const match = /^nl-hana_([\d.]+)_([^_]+)_(\d+)\.jpe?g$/i.exec(source.trim());
  if (!match) return source;
  const scanId = `NL-HaNA_${match[1]}_${match[2]}_${match[3]}`;
  return `scan ${scanId} (open with get_scan; viewer: ${viewerUrlForScan(scanId)})`;
}

export interface RecordSummary {
  uri: string;
  type: string;
  label: string | null;
  names: string[];
  classifications: string[];
  /** SKOS fields for thesaurus concepts. */
  concept?: { prefLabels: string[]; altLabels: string[]; definition: string[]; broader: string[]; narrower: string[]; inScheme: string[]; matches: string[] };
  /** Top-level properties with a count and the first few items, one line each. */
  properties: Record<string, { count: number; items: string[] }>;
  linkedEntities: LinkedEntity[];
  linkedEntitiesTotal: number;
  sources: string[];
  /** Annotation collection with corpus mentions, when the record has one. */
  mentionsCollection?: string;
}

export function summariseRecord(record: Obj, itemsPerProperty = 5): RecordSummary {
  const names = [
    ...new Set([
      ...asArray(record._label).filter((l): l is string => typeof l === 'string'),
      ...asArray(record.identified_by).map((i) => (isObj(i) && typeof i.content === 'string' ? i.content : null)).filter((s): s is string => !!s),
      ...literal(record.prefLabel),
      ...literal(record.altLabel),
    ]),
  ];

  const properties: RecordSummary['properties'] = {};
  for (const [key, value] of Object.entries(record)) {
    if (SKIP_KEYS.has(key) || value === null) continue;
    const items = asArray(value);
    if (!items.length) continue;
    properties[key] = { count: items.length, items: items.slice(0, itemsPerProperty).map((item) => truncate(oneLine(item), 500)) };
  }

  const isConcept = typeOf(record) === 'Concept' || 'broader' in record || 'inScheme' in record;
  const conceptRefs = (key: string) => asArray(record[key]).map((n) => (isObj(n) ? `${labelOf(n) ?? ''} <${n.id}>` : String(n)));
  const linked = linkedEntities(record);
  const mentions = asArray(record.subject_of).find((s) => isObj(s) && asArray(s.type).includes('AnnotationCollection'));

  return {
    uri: String(record.id ?? ''),
    type: typeOf(record),
    label: labelOf(record),
    names,
    classifications: [...new Set(asArray(record.classified_as).map(labelOf).filter((l): l is string => !!l))],
    ...(isConcept
      ? {
          concept: {
            prefLabels: literal(record.prefLabel),
            altLabels: literal(record.altLabel),
            definition: literal(record.definition),
            broader: conceptRefs('broader'),
            narrower: conceptRefs('narrower'),
            inScheme: conceptRefs('inScheme'),
            matches: ['exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch'].flatMap((k) => asArray(record[k]).map((m) => `${k}: ${isObj(m) ? m.id : m}`)),
          },
        }
      : {}),
    properties,
    linkedEntities: linked.items,
    linkedEntitiesTotal: linked.total,
    sources: citedSources(record),
    ...(isObj(mentions) && typeof mentions.id === 'string' ? { mentionsCollection: mentions.id } : {}),
  };
}

/** One property of a record, paged, as pruned JSON (blank-node ids and contexts removed). */
export function recordProperty(record: Obj, property: string, offset: number, limit: number): { count: number; items: Json[] } {
  const items = asArray(record[property]);
  return { count: items.length, items: items.slice(offset, offset + limit).map((item) => prune(item, 0)) };
}

function prune(node: Json, depth: number): Json {
  if (depth > 8) return '…';
  if (Array.isArray(node)) return node.map((child) => prune(child, depth + 1));
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '@context' || (key === 'id' && typeof value === 'string' && value.startsWith('_:'))) continue;
    if (value === null || (Array.isArray(value) && !value.length)) continue;
    out[key] = prune(value, depth + 1);
  }
  return out;
}
