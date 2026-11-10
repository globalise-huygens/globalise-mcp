// Everything that points at an external service lives here, so a deployment can override it
// with environment variables without touching code.

const env = (key: string, fallback: string): string => process.env[key]?.trim() || fallback;
const envInt = (key: string, fallback: number): number => {
  const value = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const config = {
  /** Elasticsearch proxy with the documents, persons and *-objects indices. */
  searchBase: env('GLOBALISE_SEARCH_BASE', 'https://search.globalise.nl'),
  /** Persistent identifiers of every data object (documents, scans, persons, places, ...). */
  dataBase: env('GLOBALISE_DATA_BASE', 'https://data.globalise.huygens.knaw.nl/hdl:20.500.14722'),
  /** Research portal: scan viewer (/manifest/) and object cards (/object-card/). */
  portalBase: env('GLOBALISE_PORTAL_BASE', 'https://dev.globalise.nl'),

  /** Timeout for a single upstream request. */
  requestTimeoutMs: envInt('GLOBALISE_REQUEST_TIMEOUT_MS', 30_000),
  /** Upper bound on simultaneous upstream requests from this process (all users together). */
  maxConcurrentUpstream: envInt('GLOBALISE_MAX_CONCURRENT_UPSTREAM', 8),
  /** Largest JSON-LD record we parse; some ship records are several MB. */
  maxRecordBytes: envInt('GLOBALISE_MAX_RECORD_BYTES', 25_000_000),
  /** Entries kept in the in-memory response cache. */
  cacheEntries: envInt('GLOBALISE_CACHE_ENTRIES', 500),
  /** How long cached upstream responses are reused. */
  cacheTtlMs: envInt('GLOBALISE_CACHE_TTL_MS', 15 * 60_000),

  userAgent: env('GLOBALISE_USER_AGENT', 'globalise-mcp/0.1 (+https://globalise.nl)'),
} as const;

export const INDICES = {
  documents: 'documents',
  persons: 'persons',
  places: 'place-objects',
  organisations: 'organisation-objects',
  polities: 'polity-objects',
  ships: 'ship-objects',
  concepts: 'thesaurus-objects',
} as const;

export type IndexKey = keyof typeof INDICES;
