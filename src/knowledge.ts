// Background knowledge the model needs to use the tools well and to report honestly.
// Served as MCP resources and through the globalise_about tool (not every client shows resources).
//
// The GLOBALISE website is the source of truth for what the data is, how it was made and what its
// limitations are. This file summarises it for the model and links to the pages, so the model can
// point users to them. When the website changes, update this file to match; do not let the two
// drift apart. Statements about the current state of the search indices (fields, coverage, known
// gaps) are this server's own and are marked as such.

import { config } from './config.ts';

// Pages of the GLOBALISE website, relative to config.websiteBase.
// TODO: the website is not live yet; these are the source files on GitHub. When it goes live, set
// GLOBALISE_WEBSITE_BASE (or the default in config.ts) and replace these paths with the live URLs.
const PAGES = {
  overview: 'research-responsibly/data/overview.md',
  production: 'research-responsibly/data/production.md',
  technical: 'research-responsibly/data/technical-documentation.md',
  dataModel: 'research-responsibly/data/data-model.md',
  referenceData: 'research-responsibly/data/reference-data.md',
  access: 'research-responsibly/data/access.md',
  biasAndLimitations: 'research-responsibly/ethics/bias-and-limitations.md',
  colonialContext: 'research-responsibly/ethics/colonial-context.md',
  responsibleUse: 'research-responsibly/ethics/responsible-use.md',
  vocArchivesGuide: 'research-responsibly/voc-archives-guide.md',
  aiAssistant: 'learn-get-started/ai-assistant.md',
  citation: 'learn-get-started/citation.md',
} as const;

const page = (key: keyof typeof PAGES, anchor?: string): string =>
  `${config.websiteBase}/${PAGES[key]}${anchor ? `#${anchor}` : ''}`;

export const OVERVIEW = `# GLOBALISE: what this server gives access to

GLOBALISE (https://globalise.nl, Huygens Institute) makes part of the archives of the Dutch East
India Company (VOC) searchable: the "Overgekomen Brieven en Papieren" (OBP; in English the Copied
Letters series) in archive 1.04.02 of the Nationaal Archief in The Hague. That is about 6,900
inventory numbers and 4.8 million pages, mostly from roughly 1605 to 1794. The pages are available
as automatic transcriptions (handwritten text recognition, HTR), with entities and events recognised
by language models, grouped into documents, and linked to curated reference data (persons, places,
ships, organisations, polities, a thesaurus). It is not the whole VOC archive: see "limitations".

The research portal (scan and transcription viewer, object cards) is at ${config.portalBase}.
The search indices behind this server are work in progress; fields are being added.

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

## Documentation for the user
The GLOBALISE website explains the data in full. Point the user to these pages when a limitation
matters for their question, and whenever they want to know more:
- Using GLOBALISE with an AI assistant (how to check your answers): ${page('aiAssistant')}
- Bias & limitations: ${page('biasAndLimitations')}
- What's in the data: ${page('overview')}
- How the data was produced: ${page('production')}
- Colonial context (terminology, perspective): ${page('colonialContext')}
- Responsible use: ${page('responsibleUse')}
- Guide to the VOC archives (what is and is not covered): ${page('vocArchivesGuide')}
- Technical documentation (models, code, evaluation): ${page('technical')}
- Citation guide: ${page('citation')}
`;

export const DATA_MODEL = `# Data model: how GLOBALISE objects relate

ARCHIVE (NL-HaNA 1.04.02, VOC)
 └─ INVENTORY (e.g. 1968) = usually one bound volume = one IIIF Manifest
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
 - Entity types describe the form of the words, not what they refer to: a place name is tagged as
   a place even when, in context, it stands for a ruler or a state.
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
 - Viewer:      ${config.portalBase}/manifest/?manifest=<manifest uri>&canvas=<canvas uri>
 - Object card: ${config.portalBase}/object-card/?uri=<record uri>
 (<data> = ${config.dataBase})

More:
- What's in the data: ${page('overview')}
- Data model & ontologies: ${page('dataModel')}
`;

export const LIMITATIONS = `# Source criticism, bias and limitations

This summarises the GLOBALISE website page "Bias & limitations" (${page('biasAndLimitations')}),
which is the authoritative version. Tell the user about the limitations that affect their question,
in your answer, not only when asked, and link them to that page and to "Using GLOBALISE with an AI
assistant" (${page('aiAssistant', 'checking-the-answers')}).

## The archive itself
- It is the VOC's own record: events, people and societies as the Company saw them. People outside
  the Company mostly appear when they mattered to it, often unnamed or under names given by clerks.
  Silence in the archive is not absence in history.
- Most archives kept at the Company's settlements have been lost. The OBP consists largely of copies
  sent to the Netherlands.
- Coverage is partial: only the OBP in 1.04.02, not the whole VOC archive. Not included are, among
  other things, the resolutions of the Company's directors, the correspondence sent from the Dutch
  Republic to Asia, and VOC archives held elsewhere in the world. See the guide to the VOC archives:
  ${page('vocArchivesGuide')}
- Coverage is uneven over time and space: Batavia and a few major settlements dominate; some years,
  regions and document types are thinly represented. Raw counts therefore mostly reflect what was
  kept and digitised. Use analyze_distribution, which normalises against the corpus.
- Written, digitised and searchable sources such as these are easily given more weight than other
  ways of recording the past and than other archives from the Indian Ocean world.
- The texts use historical terminology that is offensive today (e.g. on slavery and ethnicity).
  Quote faithfully but give context. See Colonial context: ${page('colonialContext')}

## Languages and scripts
- Almost 97% of pages are in Dutch only; about 13,000 pages contain another language, mostly French,
  English or Latin, a few hundred an Asian language (mostly Malay and Sinhala).
- The text recognition cannot read non-Latin scripts: pages in e.g. Chinese, Persian or Sinhala
  script appear as strings of seemingly random characters and cannot be searched for their content.
- Languages were identified automatically per page and cautiously, so non-Dutch pages are
  undercounted. Language is not a search field in this server.

## Transcriptions
- All transcriptions are automatic (HTR) and uncorrected. Expect misread characters, split/merged
  words, missing lines, and errors in numbers. A misread word cannot be found by its correct
  spelling, and errors carry through to every later step (entities, events, linking).
- Early-modern Dutch spelling varies heavily and uses many abbreviations (Comp:s = Compagnies,
  d:o = dito, ult:mo = ultimo, p:r = per, ƒ = guilders).
- Absence of a search hit is weak evidence: try spelling variants, wildcards (*) and fuzzy (~)
  before concluding something is not in the corpus.
- Always verify quotations and numbers on the scan (get_scan with include_image / quote).

## Documents
- The volumes were not originally divided into documents in a machine-readable way. GLOBALISE
  reconstructed document boundaries with a segmentation model, guided by historical indexes where
  these exist. Boundaries can be wrong: a document may start or end on the wrong scan, or two
  documents may be merged or one split. The model is much less reliable in volumes without an index,
  mostly of the Zeeland Chamber (inventory numbers 9180–10405 and 10436–11024).
- Titles without square brackets come from the existing indexes, which follow the VOC's own tables
  of contents: they reflect the Company's perspective (what it thought a document was about, whom it
  named) and can cover a letter together with its enclosures. Titles in square brackets were not
  given by the VOC; most were inferred by the project and give only type, place and date.
- Inferred titles, dates and places can be wrong. Research that counts documents per type, place or
  year should treat these fields critically.
- Current index (this server): the index does not yet contain the final segmentation described on
  the website. Titles like "[Unknown document, Bengal]" mean no match with an index entry. Dates can
  be year-level approximations (e.g. 1764-01-01). The settlement field is empty for about a third of
  the documents.
- More: How the data was produced, section 3: ${page('production', '3-identifying-documents')}

## Entities and events
- Entities and events are recognised automatically by language models; only part was checked by
  hand. They contain errors in both directions: wrong types, missed mentions, spurious tags. Do not
  present a tag as an established fact.
- Event detection was one of the hardest tasks: events are described in many ways and often only
  implied. Treat event tags with particular care.
- Current index (this server): only some place mentions are linked to a place record (placeId).
  Person mentions carry a role concept (personId), not the identity of the person. Named persons,
  ships, organisations and polities are matched by spelling only: homonyms (e.g. ships named after
  common words, or several ships with the same name) produce false hits, unrecorded spellings
  produce misses. The "corpus mentions" annotation collections attached to reference records are
  incomplete; prefer search_documents with the entity id for coverage.

## Reference data
- Compiled and checked by historians from many sources (existing VOC databases, literature, the
  transcriptions themselves). Curated, but not neutral: built mostly from colonial sources in Dutch
  and English, so colonial names and categories are recorded more fully than local ones.
- Each record cites its sources; check them. Records may be undisambiguated (the record says so) or
  merge several historical individuals or ships.
- The project prioritised political and economic subjects; other domains are covered less.
- The thesaurus mixes Dutch historical terms and modern categories; hierarchy levels group
  concepts for search, not as a historical claim.
- More: ${page('referenceData')}

## Search mechanics
- search_documents and analyze_distribution count documents; count_mentions counts occurrences.
  Report which one a figure is. Mention totals are dominated by long registers and lists (one
  muster roll can mention "soldaat" hundreds of times), so give per-document figures and the top
  documents alongside totals. Above a threshold (default 500 documents) mention totals are
  estimates from a random sample, reported with a 95% interval.
- Document totals above 10,000 are exact only when requested; paging stops at 10,000 hits.
- Relevance ranking is lexical (BM25), not semantic. There are no English translations; any
  translation or summary you give is your own and unchecked: say so.
- The indices are work in progress and are rebuilt periodically; cite the index version that the
  tools report (e.g. annotated-documents.2026.11.05) together with document/scan ids.

## Interpretation, and your own role
- A search result is a fragment of a larger document, shaped by its type, author and purpose. Read
  the surrounding text before drawing conclusions.
- The data can show what was recorded, where and when; explaining how and why things happened is
  interpretation. Keep what the sources say apart from your own conclusions.
- You add a layer of your own: which searches you ran, what you read, how you summarised it. Say
  how you searched, do not fill gaps with knowledge from outside the corpus without saying so, and
  never present a quotation you have not verified on the scan.
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
   version. Keep what the sources say apart from your interpretation.
7. End with the limitations that affect this answer (globalise_about topic "limitations"), and link
   the user to Bias & limitations (${page('biasAndLimitations')}) and to how to check your answer
   (${page('aiAssistant', 'checking-the-answers')}).
`;

export const TOPICS = {
  overview: OVERVIEW,
  data_model: DATA_MODEL,
  limitations: LIMITATIONS,
  query_syntax: QUERY_SYNTAX,
  workflow: WORKFLOW,
} as const;

export type Topic = keyof typeof TOPICS;

export const SERVER_INSTRUCTIONS = `This server gives access to GLOBALISE: about 4.8 million pages of the VOC (Dutch East India
Company) archives, mostly 1605–1794, as uncorrected machine transcriptions with automatic annotations,
reconstructed documents and curated reference data. The texts are early-modern Dutch with heavy
spelling variation and HTR errors. Before substantive research, read globalise_about (topics
data_model and limitations). Resolve entities to ids before searching, use analyze_distribution to
judge coverage, verify quotes and numbers with get_scan, and always cite document/scan ids, viewer
links and the index version. In every substantive answer, state the limitations that apply
(automatic transcription and annotation, the Company's perspective, partial and uneven coverage) and
link the user to Bias & limitations (${page('biasAndLimitations')}) and to how to check your answers
(${page('aiAssistant', 'checking-the-answers')})`;
