import { describe, expect, it } from 'vitest';
import { parseAnnotated, plainText, renderFragment, summariseEntities } from '../src/globalise/annotatedText.ts';
import { documentContainsScan, documentScanIds, parseId, viewerUrlForDocument } from '../src/globalise/ids.ts';
import { buildDocumentQuery, collectChips, parse } from '../src/globalise/query.ts';
import { tallyFragments } from '../src/globalise/mentions.ts';
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
    expect(viewerUrlForDocument('NL-HaNA_1.04.02_1968_0347-0350')).toContain('canvas%3ANL-HaNA_1.04.02_1968_0347');
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
