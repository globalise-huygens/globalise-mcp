// Background knowledge the model needs to use the tools well and to report honestly.
// Served as MCP resources and through the globalise_about tool (not every client shows resources).
// Keep this in sync with the indices: they are work in progress.

export const OVERVIEW = `# GLOBALISE: what this server gives access to

GLOBALISE (https://globalise.nl, Huygens Institute) makes the archives of the Dutch East India
Company (VOC, 1602–1799) searchable: the "Overgekomen brieven en papieren" and related series in
the Nationaal Archief (archive NL-HaNA 1.04.02), roughly 1600–1806, as machine transcriptions
(handwritten text recognition, HTR) enriched with automatically generated annotations and linked
to curated reference data (persons, places, ships, organisations, polities, a thesaurus).

The research portal is in beta at https://dev.globalise.nl (scan + transcription viewer, object
cards). Indices behind this server are work in progress; fields are being added.

## Tools
- search_documents: full-text + structured search in the annotated transcriptions.
- analyze_distribution: how a result set is spread over time, settlements, document types,
  professions and archive series, compared with the whole corpus (to correct for coverage bias).
- count_mentions: how often the search terms occur in total (not how many documents), with the
  spellings matched, mentions per decade normalised by corpus size, and the top documents.
- search_reference_data: find persons, places, ships, organisations, polities, thesaurus concepts.
- get_record: the full reference record (or document metadata) for any GLOBALISE id/URI.
- get_document: a document's metadata, text (paged), tagged entities and scan list.
- get_scan: one page: transcription, annotations, IIIF image (optionally the image itself, or a
  crop around a quoted passage) and a viewer link. Use this to verify claims against the original.
- globalise_about: this documentation (topics: overview, data_model, limitations, query_syntax, workflow).
`;

export const DATA_MODEL = `# Data model: how GLOBALISE objects relate

ARCHIVE (NL-HaNA 1.04.02, VOC)
 └─ INVENTORY (e.g. 1968) = one bound volume = one IIIF Manifest
     │  <data>/inventory:1968.manifest  (scans, table of contents as IIIF Ranges)
     └─ SCAN (e.g. NL-HaNA_1.04.02_1968_0347) = one page image = IIIF Canvas
         │  <data>/canvas:NL-HaNA_1.04.02_1968_0347
         │  annotation pages per scan:
         │   - annotations:transcriptions:<scan>  page text (normalised + diplomatic HTR), lines, words with polygons
         │   - annotations:entities:<scan>        named-entity annotations (NER)
         │   - annotations:events:<scan>          event annotations (e.g. Move, Payment, Attack)
         │  image: IIIF Image API at the Nationaal Archief (service.archief.nl)
         └─ DOCUMENT (e.g. NL-HaNA_1.04.02_1968_0347-0350) = a run of consecutive scans
             <data>/document:<id>  Linked Art record: title, date, place of writing, document type
             Indexed in "documents" with annotatedText, title, startDate/endDate, settlement,
             inventoryNumber, archive hierarchy (eadIdPaths), documentTypeIdPaths, professionIdPaths.

TEXT ANNOTATIONS (inside annotatedText)
 - type: Person, Place, Group, HumanMadeObject (ships, objects), PersistentItem, Dimension
   (quantities/money), TimeSpan (dates), and event/state types (Voyage, Move, Payment, Attack,
   CorrespondenceEvent, PhysicalLocativeStatus, SocialRelationStatus, ...).
 - placeId → PLACE record (place-objects). Only part of the place mentions are linked.
 - personId → a THESAURUS concept for the person's ROLE/PROFESSION at that spot (e.g. koopman),
   NOT a person record. Named persons, ships, organisations and polities are NOT linked by id in
   the text yet; they can only be found by matching their recorded spellings.

REFERENCE DATA (each has a persistent URI <data>/<kind>:<id> resolving to JSON-LD)
 - person:Person_…   persons index: names (all spellings), occupations, statuses, identities
                     (thesaurus ids), relations; record: birth/death, events, sources (often a scan).
 - place:GLOB2_…     places: names, types, coordinates/approximation, part_of, sources.
 - group:ORG_…       organisations (e.g. ORG_1 = the VOC), with classifications over time.
 - polity:Polity_…   polities (states, kingdoms), with sources.
 - ship:gzm_ship…    ships, with voyages (voyage:gzm_voyage…), type, ownership.
 - thesaurus:<uuid>  SKOS concepts: occupations, ranks, statuses, identities, document types,
                     commodities, ...; broader/narrower hierarchy; Dutch + English labels.

PORTAL LINKS
 - Viewer:      https://dev.globalise.nl/manifest/?manifest=<manifest uri>&canvas=<canvas uri>
 - Object card: https://dev.globalise.nl/object-card/?uri=<record uri>
 (<data> = https://data.globalise.huygens.knaw.nl/hdl:20.500.14722)
`;

export const LIMITATIONS = `# Source criticism, bias and limitations

Report these to the user whenever they affect a conclusion.

## The archive itself
- It is the VOC's own record: the perspective of a colonial trading company and its officials.
  Asian, African and enslaved people appear mostly as objects of Company administration, often
  unnamed or under names given by clerks. Silence in the archive is not absence in history.
- Coverage is uneven over time and space: Batavia and a few major settlements dominate; some
  years, regions and document types are thinly represented. Raw counts therefore mostly reflect
  what was kept and digitised. Use analyze_distribution, which normalises against the corpus.
- The material consists largely of copies sent to the Netherlands; originals, local archives and
  non-Company sources are not included.
- The texts use historical terminology that is offensive today (e.g. on slavery and ethnicity).
  Quote faithfully but contextualise.

## Transcriptions
- Machine transcriptions (HTR), largely uncorrected. Expect misread characters, split/merged words,
  missing lines, and errors in numbers. Early-modern Dutch spelling varies heavily and uses many
  abbreviations (Comp:s = Compagnies, d:o = dito, ult:mo = ultimo, p:r = per, ƒ = guilders).
- Absence of a search hit is weak evidence: try spelling variants, wildcards (*) and fuzzy (~)
  before concluding something is not in the corpus.
- Always verify quotations and numbers on the scan (get_scan with include_image / quote).

## Documents
- Document boundaries, titles and dates are partly derived automatically (matching against
  inventory tables of contents, with confidence scores). Titles like "[Unknown document, Bengal]"
  mean no match. Dates can be year-level approximations (e.g. 1764-01-01). The settlement field is
  empty for about a third of the documents.

## Annotations
- Entities and events are tagged automatically (NER + event detection) and contain errors in both
  directions: wrong types, missed mentions, spurious tags.
- Only some place mentions are linked to a place record (placeId). Person mentions carry a role
  concept (personId), not the identity of the person. Named persons, ships, organisations and
  polities are matched by spelling only: homonyms (e.g. ships named after common words) produce
  false hits, unrecorded spellings produce misses.
- The "corpus mentions" annotation collections attached to reference records are incomplete;
  prefer search_documents with the entity id for coverage.

## Reference data
- Compiled from many sources (e.g. existing VOC databases, literature, the transcriptions
  themselves). Each record cites its sources; check them. Records may be undisambiguated (the
  record says so) or merge several historical individuals/ships.
- The thesaurus mixes Dutch historical terms and modern categories; hierarchy levels group
  concepts for search, not as a historical claim.

## Search mechanics
- search_documents and analyze_distribution count documents; count_mentions counts occurrences.
  Report which one a figure is. Mention totals are dominated by long registers and lists (one
  muster roll can mention "soldaat" hundreds of times), so give per-document figures and the top
  documents alongside totals. Above a threshold (default 500 documents) mention totals are
  estimates from a random sample, reported with a 95% interval.
- Document totals above 10,000 are exact only when requested; paging stops at 10,000 hits.
- Relevance ranking is lexical (BM25), not semantic. There are no English translations yet.
- The indices are work in progress and are rebuilt periodically; cite the index version that the
  tools report (e.g. annotated-documents.2026.11.05) together with document/scan ids.
`;

export const QUERY_SYNTAX = `# Query syntax (search_documents "query")

Free text (searched in the transcription, case-insensitive):
  peper                     a word
  "Coromandel kust"         an exact phrase
  timmer*  sl?ven           wildcards
  timmerman~1               fuzzy (edit distance 1; ~ alone = automatic)
  peper AND NOT foelie      boolean: AND (optional), OR, NOT, parentheses
  (amsterdam timmerman)~5   proximity: all items within 5 words, any order

Fields (can also be combined inside proximity groups):
  place:GLOB2_937           a place by id: every spelling tagged with that place
  place:Amster*             spelling tagged as a Place (no id; misses other spellings)
  person:Person_100901      a named person: all recorded spellings (by name, no id in text)
  person:"Jan Pietersz"     a literal name
  ship:gzm_ship0511         a ship by record id (all names); organisation:ORG_x; polity:Polity_x
  role:koopman              a person mention tagged with this role concept (label or uuid)
  profession:<label|uuid>   document-level profession facet, includes narrower concepts
  concept:<uuid>            any use of a thesaurus concept
  annotation:Payment        a tag type: Person, Place, Voyage, Attack, Payment, Dimension, ...
  documenttype:<label|uuid> e.g. documenttype:brief
  title:<words>             words in the document title
  settlement:Batavia        place of writing (exact; wildcards allowed)
  archive:<words>           a series/section of the archive description
  inventory:1968            inventory number (wildcards allowed)
  year:1685  year:1680-1690 documents whose date range overlaps

Examples:
  (place:GLOB2_937 timmerman)~10
  annotation:Attack settlement:Ceylon year:1650-1660
  (role:slaaf "verkocht")~8
`;

export const WORKFLOW = `# Research workflow

1. Clarify the question; translate key terms into period Dutch, with spelling variants
   (e.g. peper/peeper, slaaf/slaven/slaeven, Coromandel/Choromandel/Cormandel).
2. Resolve entities first with search_reference_data (place ids, person/ship records, thesaurus
   concepts), then search documents by id where possible; it is more complete than spelling.
3. Gauge the size and shape of the evidence with analyze_distribution (documents) and
   count_mentions (occurrences); always look at corpus-normalised figures, not only raw counts.
4. Read: get_document for the text around hits (use the inline format to see tags), and follow
   linked records with get_record.
5. Verify every quotation, name and number you report on the scan: get_scan with quote=... returns
   a crop of the passage; give the user the viewer link.
6. Report with citations: document id, scan id, date, viewer link, the queries used, the index
   version, and the limitations that apply (see globalise_about topic "limitations").
`;

export const TOPICS = {
  overview: OVERVIEW,
  data_model: DATA_MODEL,
  limitations: LIMITATIONS,
  query_syntax: QUERY_SYNTAX,
  workflow: WORKFLOW,
} as const;

export type Topic = keyof typeof TOPICS;

export const SERVER_INSTRUCTIONS = `This server gives access to GLOBALISE: machine-transcribed VOC (Dutch East India Company)
archives 1600–1806 with automatic annotations and curated reference data. The texts are early-modern
Dutch with heavy spelling variation and HTR errors. Before substantive research, read
globalise_about (topics data_model and limitations). Resolve entities to ids before searching,
use analyze_distribution to judge coverage, verify quotes and numbers with get_scan, and always
cite document/scan ids, viewer links and the index version. State the limitations that apply
(automatic transcription/annotation, colonial archive perspective, uneven coverage).`;
