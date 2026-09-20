import type { Work } from './judge';

/**
 * The service being sold: a research desk with a tiny local corpus. No network, no model, nothing
 * to configure — the point of the example is what the answer is worth, not how it was written.
 *
 * Its three shapes of answer are the three tiers: one card restated, a few combined, several
 * weighed. A real desk's work varies the same way and just as unpredictably per request.
 */

type Card = { readonly topic: readonly string[]; readonly text: string; readonly source: string };

const CORPUS: readonly Card[] = [
  { topic: ['tide', 'tokyo'], text: 'Tokyo Bay runs two high tides a day, roughly 50 minutes later each day.', source: 'jma/tide-tables' },
  { topic: ['tide', 'moon'], text: 'Spring tides follow the new and full moon by about a day and a half.', source: 'noaa/tides-and-currents' },
  { topic: ['tide', 'fishing'], text: 'Anglers on the bay favour the two hours around a rising mid-tide.', source: 'tsuribito/seasonal-notes' },
  { topic: ['ferry', 'tokyo'], text: 'The Takeshiba to Oshima jetfoil is cancelled when swell exceeds 2.5 metres.', source: 'tokai-kisen/service-rules' },
  { topic: ['ferry', 'refund'], text: 'A cancelled sailing is refunded in full; a missed connection is not.', source: 'tokai-kisen/tariff' },
  { topic: ['weather', 'tokyo'], text: 'Tokyo averages 11 typhoon-affected days a year, concentrated in September.', source: 'jma/climate-normals' },
  { topic: ['weather', 'swell'], text: 'Swell over 2.5 metres at Oshima is most likely in September and October.', source: 'jma/wave-climate' },
];

export function research(question: string): Work {
  const started = Date.now();
  const words = question
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 2);
  const hits = CORPUS.filter((card) => card.topic.some((topic) => words.includes(topic)));

  const answer =
    hits.length === 0
      ? ''
      : hits.length === 1
        ? (hits[0]?.text ?? '')
        : `${hits.map((card) => card.text).join(' ')} Taken together: ${conclusion(hits)}`;

  return {
    question,
    answer,
    sources: hits.length,
    charactersWritten: answer.length,
    millisecondsSpent: Date.now() - started,
  };
}

export function sourcesFor(question: string): readonly string[] {
  const words = question
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 2);
  return CORPUS.filter((card) => card.topic.some((topic) => words.includes(topic))).map((card) => card.source);
}

/** The part a lookup does not have: a claim none of the sources make on its own. */
function conclusion(hits: readonly Card[]): string {
  return hits.length >= 3
    ? 'plan the crossing for the days after a full moon and before the September swell, and buy a refundable ticket.'
    : 'the two agree, so the simple reading holds.';
}
