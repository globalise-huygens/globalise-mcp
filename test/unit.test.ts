import { describe, expect, it } from 'vitest';
import { parseAnnotated, plainText, renderFragment, summariseEntities } from '../src/globalise/annotatedText.ts';
import { documentContainsScan, documentScanIds, parseId, viewerUrlForDocument } from '../src/globalise/ids.ts';
import { viewerHitQuery, viewerSnippet } from '../src/globalise/annotatedText.ts';
import { buildDocumentQuery, collectChips, parse } from '../src/globalise/query.ts';
import { tallyFragments } from '../src/globalise/mentions.ts';
import { broaderChains, buildPlaceGraph, distanceKm, inBox, parsePoint, placesInFragments, regionOf, resolvePlace } from '../src/globalise/places.ts';
import { locateQuote } from '../src/globalise/scan.ts';
import { RateLimiter } from '../src/util/rateLimit.ts';

describe('ids', () => {
  it('recognises bare ids, prefixed ids and URIs', () => {
    expect(parseId('GLOB2_937')?.kind).toBe('place');
    expect(parseId('Person_100901')?.kind).toBe('person');
    expect(parseId('gzm_ship0511')?.kind).toBe('ship');
    expect(parseId('ORG_1')?.kind).toBe('group');
    expect(parseId('Polity_100')?.kind).toBe('polity');
    expect(parseId('5b2cb1a2-fb88-4958-b94b-d4c66b536cc8')?.kind).toBe('thesaurus');
    expect(parseId('NL-HaNA_1.04.02_1968_0347-0350')?.kind).toBe('document');
    expect(parseId('NL-HaNA_1.04.02_1968_0347')?.kind).toBe('scan');
    expect(parseId('inventory:1968')?.kind).toBe('inventory');
    const uri = parseId('https://data.globalise.huygens.knaw.nl/hdl:20.500.14722/place:GLOB2_937.annotations');
    expect(uri).toMatchObject({ kind: 'place', id: 'GLOB2_937' });
    expect(parseId('https://data.globalise.huygens.knaw.nl/hdl:20.500.14722/canvas:NL-HaNA_1.04.02_1968_0347')?.kind).toBe('scan');
    expect(parseId('nonsense words')).toBeNull();
  });

  it('expands and tests document scan ranges', () => {
    expect(documentScanIds('NL-HaNA_1.04.02_1968_0347-0350')).toEqual([
      'NL-HaNA_1.04.02_1968_0347',
      'NL-HaNA_1.04.02_1968_0348',
      'NL-HaNA_1.04.02_1968_0349',
      'NL-HaNA_1.04.02_1968_0350',
    ]);
    expect(documentContainsScan('NL-HaNA_1.04.02_1968_0347-0350', 'NL-HaNA_1.04.02_1968_0349')).toBe(true);
    expect(documentContainsScan('NL-HaNA_1.04.02_1968_0347-0350', 'NL-HaNA_1.04.02_1969_0349')).toBe(false);
    const viewer = viewerUrlForDocument('NL-HaNA_1.04.02_1968_0347-0350')!;
    expect(viewer).toContain('/hdl:20.500.14722/inventory:1968/0347?');
    expect(viewer).toContain('manifest=https%3A%2F%2Fdata.globalise.huygens.knaw.nl%2Fhdl%3A20.500.14722%2Finventory%3A1968.manifest');
    expect(viewer).toContain('canvas%3ANL-HaNA_1.04.02_1968_0347');
  });
});

describe('annotated text', () => {
  const sample =
    'te [Amsterdam](_hit_term=placeId%3AGLOB2_937&type%3APlace&placeId%3AGLOB2_937) de [Coopman](type%3APerson&personId%3A45598da5-1a81-436e-939c-80f064ea0043) [Ioan Muis](type%3APerson) [getekend klavertje] [ƒ 156](type%3ADimension)';

  it('parses spans and keeps literal brackets', () => {
    const segments = parseAnnotated(sample);
    expect(plainText(segments)).toBe('te Amsterdam de Coopman Ioan Muis [getekend klavertje] ƒ 156');
  });

  it('renders hits and tags compactly', () => {
    expect(renderFragment(sample)).toBe(
      'te «[Amsterdam]{Place place:GLOB2_937}» de [Coopman]{Person role:45598da5-1a81-436e-939c-80f064ea0043} [Ioan Muis]{Person} [getekend klavertje] [ƒ 156]{Dimension}',
    );
  });

  it('summarises entities', () => {
    const summary = summariseEntities(parseAnnotated(sample));
    expect(summary.places).toEqual([{ placeId: 'GLOB2_937', surfaces: ['Amsterdam'], count: 1 }]);
    expect(summary.roles[0].conceptId).toBe('45598da5-1a81-436e-939c-80f064ea0043');
    expect(summary.personNames).toEqual([{ surface: 'Ioan Muis', count: 1 }]);
    expect(summary.annotationTypes.Person).toBe(2);
  });
});

describe('query language', () => {
  it('parses fields, booleans and proximity', () => {
    const tree = parse('(place:GLOB2_937 timmerman)~10 AND NOT peper year:1700-1710');
    expect(tree?.t).toBe('and');
    expect(collectChips(tree).map((c) => c.fieldKey)).toEqual(['place', 'year']);
  });

  it('compiles a place id to an annotation term inside span_near', () => {
    const tree = parse('(place:GLOB2_937 timmerman)~10');
    collectChips(tree).forEach((chip) => (chip.id = chip.value));
    const query = JSON.stringify(buildDocumentQuery(tree, []));
    expect(query).toContain('"span_near"');
    expect(query).toContain('"placeId:GLOB2_937"');
  });

  it('escapes Lucene syntax in abbreviations such as Comp:s', () => {
    const query = JSON.stringify(buildDocumentQuery(parse('Comp:s'), []));
    expect(query).toContain('Comp\\\\:s');
  });

  it('turns year ranges into overlapping date filters', () => {
    const query = JSON.stringify(buildDocumentQuery(parse('year:1700-1710'), []));
    expect(query).toContain('"lte":"1710-12-31"');
    expect(query).toContain('"gte":"1700-01-01"');
  });
});

describe('locateQuote', () => {
  const words = ['Specificatie', 'van', 'alle', 'soodanige', 'dranken', 'als'].map((text, i) => ({
    text,
    box: [100 + i * 100, 200, 90, 40] as [number, number, number, number],
    order: i,
  }));

  it('finds a passage and returns a padded region', () => {
    const found = locateQuote(words, 'van alle soodanige', 10);
    expect(found).toMatchObject({ matchedWords: 3, quoteWords: 3, matchedText: 'van alle soodanige', region: '190,190,310,60' });
  });

  it('tolerates an HTR error in one word', () => {
    expect(locateQuote(words, 'van alle zoodanige dranken')?.matchedWords).toBe(3);
  });

  it('returns null when the passage is absent', () => {
    expect(locateQuote(words, 'peper en nagelen')).toBeNull();
  });
});

describe('mention counting', () => {
  it('counts highlighted spans by query term and by spelling', () => {
    const tally = tallyFragments([
      '[Caneel](_hit_term=annotatedText%3Acaneel*&type%3ADimension) en [caneelen](_hit_term=annotatedText%3Acaneel*)',
      '[voor de kamer](_hit_term=voor+de+kamer) te [Amsterdam](_hit_term=placeId%3AGLOB2_937&type%3APlace&placeId%3AGLOB2_937) [peper](type%3ADimension)',
    ]);
    expect(tally.total).toBe(4);
    expect(Object.fromEntries(tally.byTerm)).toEqual({ 'caneel*': 2, 'voor de kamer': 1, 'placeId:GLOB2_937': 1 });
    expect(tally.bySurface.get('caneel')).toBe(1);
    expect(tally.bySurface.get('caneelen')).toBe(1);
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then asks to wait', () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.take('a', 0)).toBe(0);
    expect(limiter.take('a', 0)).toBe(0);
    expect(limiter.take('a', 0)).toBeGreaterThan(0);
    expect(limiter.take('b', 0)).toBe(0);
    expect(limiter.take('a', 30_000)).toBe(0);
  });
});

describe('viewer highlighting', () => {
  const fragment =
    'atavia](type%3APlace) van de [Coopman](type%3APerson) gesonden naer [Amsterdam](_hit_term=placeId%3AGLOB2_937&type%3APlace&placeId%3AGLOB2_937) met het schip de [Peper](_hit_term=peper) ende andere goederen die men aldaer [verw';

  it('builds q from the matched words and a short snippet around the first hit', () => {
    expect(viewerHitQuery([fragment, '[peper](_hit_term=peper)'])).toBe('"Amsterdam" OR "Peper"');
    const snippet = viewerSnippet(fragment)!;
    expect(snippet).toContain('Amsterdam');
    expect(snippet).not.toMatch(/[[\]()]/);
    expect(snippet.length).toBeLessThan(100);
    expect(viewerSnippet('geen [treffer](type%3APlace) hier')).toBeNull();
  });

  it('links the document with the highlight and without a canvas', () => {
    const url = new URL(viewerUrlForDocument('NL-HaNA_1.04.02_1968_0347-0350', { q: '"Amsterdam"', snippet: 'naer Amsterdam met' })!);
    expect(url.pathname).toBe('/hdl:20.500.14722/inventory:1968/0347-0350');
    expect(url.searchParams.get('q')).toBe('"Amsterdam"');
    expect(url.searchParams.get('document')).toBe('NL-HaNA_1.04.02_1968_0347-0350');
    expect(url.searchParams.get('documentId')).toBe('NL-HaNA_1.04.02_1968_0347-0350');
    expect(url.searchParams.get('snippet')).toBe('naer Amsterdam met');
    expect(url.searchParams.get('manifest')).toContain('inventory:1968.manifest');
    expect(url.searchParams.has('canvas')).toBe(false);
  });
});

describe('places', () => {
  const P = (id: string) => `https://id.globalise.nl/hdl:20.500.14722/place:${id}`;
  const graph = buildPlaceGraph(
    [
      { id: 'CITY', source: { title: ['Calechut', 'Kozhikode'], place: [P('CITY_HUM_1'), P('ADMIN')], placeHierarchy: [P('ADMIN')], geoPoint: { lat: 11.258, lon: 75.777 } } },
      { id: 'CITY_HUM_1', source: { title: ['Kozhikode (kingdom)'], place: [P('CITY'), P('KINGDOM')], placeHierarchy: [P('KINGDOM')], geoPoint: { lat: 11.258, lon: 75.777 } } },
      { id: 'FORT', source: { title: ['Chettuva Fort'], place: [P('CITY_HUM_1')], placeHierarchy: [P('CITY_HUM_1')], geoPoint: { lat: 10.53, lon: 76.05 } } },
      { id: 'FAR', source: { title: ['Batavia'], geoPoint: { lat: -6.13, lon: 106.82 } } },
      { id: 'NOPOINT', source: { title: ['Nowhere'], placeHierarchy: [P('ADMIN')] } },
    ],
    { labels: new Map([['ADMIN', 'Kerala']]), documents: new Map([['CITY', 100], ['FORT', 3], ['FAR', 500], ['NOPOINT', 2]]) },
  );

  it('builds parents, children and symmetric overlaps; unindexed parents get their label', () => {
    const admin = graph.nodes.get('ADMIN')!;
    expect(admin).toMatchObject({ label: 'Kerala', indexed: false });
    expect(admin.children.sort()).toEqual(['CITY', 'NOPOINT']);
    expect(graph.nodes.get('CITY')!.overlaps).toEqual(['CITY_HUM_1']);
    expect(graph.nodes.get('CITY_HUM_1')!.overlaps).toEqual(['CITY']);
    expect(graph.nodes.get('CITY_HUM_1')!.children).toEqual(['FORT']);
  });

  it('expands within over the hierarchy and, optionally, overlapping places', () => {
    const region = regionOf(graph, { within: 'Kerala' });
    expect(region.members.map((n) => n.id).sort()).toEqual(['ADMIN', 'CITY', 'CITY_HUM_1', 'FORT', 'NOPOINT']);
    expect(region.linked.map((n) => n.id)).toEqual(['CITY', 'FORT', 'NOPOINT']);
    expect(region.overlapsFollowed).toHaveLength(1);
    const strict = regionOf(graph, { within: 'ADMIN', follow_overlaps: false });
    expect(strict.linked.map((n) => n.id)).toEqual(['CITY', 'NOPOINT']);
  });

  it('selects by box and radius, and intersects criteria', () => {
    expect(regionOf(graph, { bbox: { south: 5, west: 70, north: 15, east: 80 } }).linked.map((n) => n.id)).toEqual(['CITY', 'FORT']);
    expect(regionOf(graph, { near: 'Kozhikode', radius_km: 10 }).linked.map((n) => n.id)).toEqual(['CITY']);
    expect(regionOf(graph, { near: '11.2,75.8', radius_km: 200, within: 'ADMIN', follow_overlaps: false }).linked.map((n) => n.id)).toEqual(['CITY']);
  });

  it('resolves names, ids and URIs; rejects unknown places', () => {
    expect(resolvePlace(graph, 'kozhikode').node.id).toBe('CITY');
    expect(resolvePlace(graph, P('FORT')).node.id).toBe('FORT');
    expect(() => resolvePlace(graph, 'Atlantis')).toThrow(/No place named/);
  });

  it('walks up the hierarchy from the place and its overlapping senses', () => {
    expect(broaderChains(graph, 'FORT').map((c) => c.chain.map((n) => n.id).join('>'))).toEqual(['FORT>CITY_HUM_1>KINGDOM']);
    expect(broaderChains(graph, 'CITY').map((c) => c.chain.map((n) => n.id).join('>'))).toEqual(['CITY>ADMIN', 'CITY_HUM_1>KINGDOM']);
  });

  it('geometry helpers', () => {
    expect(Math.round(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }))).toBe(111);
    expect(inBox({ lat: 0, lon: 179 }, { south: -1, west: 170, north: 1, east: -170 })).toBe(true);
    expect(inBox({ lat: 0, lon: 0 }, { south: -1, west: 170, north: 1, east: -170 })).toBe(false);
    expect(parsePoint('-6.13, 106.82')).toEqual({ lat: -6.13, lon: 106.82 });
    expect(parsePoint('Batavia')).toBeNull();
  });

  it('compiles within: to a terms clause, and to span_or inside proximity', () => {
    const tree = parse('(within:Kerala peper)~10 within:Kerala');
    for (const chip of collectChips(tree)) chip.ids = ['CITY', 'FORT'];
    const query = JSON.stringify(buildDocumentQuery(tree, []));
    expect(query).toContain('"terms":{"annotatedText":["placeId:CITY","placeId:FORT"]}');
    expect(query).toContain('"span_or":{"clauses":[{"span_term":{"annotatedText":"placeId:CITY"}}');
  });

  it('reads linked places and their spellings from highlight fragments', () => {
    const fragments = [
      '[Cochim](_hit_term=annotatedText%3AplaceId%3A*&type%3APlace&placeId%3AGLOB_299)',
      '[cochim](_hit_term=annotatedText%3AplaceId%3A*&type%3APlace&placeId%3AGLOB_299)',
      '[Ceijlon](_hit_term=annotatedText%3AplaceId%3A*&type%3APlace&placeId%3AGLOB_800) [Coopman](type%3APerson)',
    ];
    expect(placesInFragments(fragments)).toEqual([
      { id: 'GLOB_299', mentions: 2, spellings: ['Cochim', 'cochim'] },
      { id: 'GLOB_800', mentions: 1, spellings: ['Ceijlon'] },
    ]);
  });

  it('recognises admin-region and NR place ids', () => {
    expect(parseId('NEW_ADMIN_1076')?.kind).toBe('place');
    expect(parseId('NR_36')?.kind).toBe('place');
  });
});
