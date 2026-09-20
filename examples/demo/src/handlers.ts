import { formatMoney, money, type Context } from 'tollstile';

/** Deterministic, cheap work: the demo is about the payment, not the service. */
export function forecast(city: string) {
  const days = ['clear', 'cloudy', 'rain', 'clear', 'windy', 'clear', 'snow'];
  const offset = Array.from(city, (character) => character.charCodeAt(0)).reduce((sum, code) => sum + code, 0);
  return { city, forecast: days[offset % days.length], week: days.map((_, i) => days[(offset + i) % days.length]) };
}

export function translate(text: string) {
  const translated = text
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => `${word.at(-1) ?? ''}${word.slice(0, -1)}`)
    .join(' ');
  return { translated, words: words(text) };
}

export function summarize(text: string, sentences: number) {
  const parts = text.split(/(?<=[.!?。])\s*/).filter((part) => part.trim() !== '');
  return { summary: parts.slice(0, sentences).join(' '), sentences: parts.length, words: words(text) };
}

export function words(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** $0.001 per word, from the body Tollstile priced. The quote binds to that exact body. */
export async function pricePerWord(context: Context): Promise<string> {
  const text = (await context.request?.text()) ?? '';
  return formatMoney(money('USD', BigInt(Math.max(words(text), 1)) * 1_000n));
}

/**
 * A research desk with a tiny corpus: some questions are one card restated, some are several
 * weighed together. What each answer was worth is decided afterwards, by a judge.
 */
const CORPUS: readonly { topic: readonly string[]; text: string; source: string }[] = [
  { topic: ['tide', 'tokyo'], text: 'Tokyo Bay runs two high tides a day, roughly 50 minutes later each day.', source: 'jma/tide-tables' },
  { topic: ['tide', 'moon'], text: 'Spring tides follow the new and full moon by about a day and a half.', source: 'noaa/tides-and-currents' },
  { topic: ['fishing'], text: 'Anglers on the bay favour the two hours around a rising mid-tide.', source: 'tsuribito/seasonal-notes' },
  { topic: ['ferry', 'jetfoil', 'cancelled'], text: 'The Takeshiba to Oshima jetfoil is cancelled when swell exceeds 2.5 metres.', source: 'tokai-kisen/service-rules' },
  { topic: ['refund', 'refunded', 'connection'], text: 'A cancelled sailing is refunded in full; a missed connection is not.', source: 'tokai-kisen/tariff' },
  { topic: ['typhoon'], text: 'Tokyo averages 11 typhoon-affected days a year, concentrated in September.', source: 'jma/climate-normals' },
  { topic: ['swell', 'september'], text: 'Swell over 2.5 metres at Oshima is most likely in September and October.', source: 'jma/wave-climate' },
];

export function research(question: string): { answer: string; sources: readonly string[]; evidence: readonly string[] } {
  // Plurals count: "typhoons" should find the typhoon card. A stemmer this crude is fine for a
  // corpus of seven cards, and the judge is what decides whether the answer earned anything.
  const words = new Set(
    question
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 2)
      .flatMap((word) => (word.endsWith('s') ? [word, word.slice(0, -1)] : [word])),
  );
  const hits = CORPUS.filter((card) => card.topic.some((topic) => words.has(topic)));
  if (hits.length === 0) return { answer: '', sources: [], evidence: [] };
  const conclusion =
    hits.length >= 3
      ? ' Weighing these against each other: the swell that cancels the jetfoil peaks in the same weeks as the typhoon season, so a September crossing is the one most likely to be cancelled — and a cancellation is refunded while a missed onward connection is not, which puts the real risk on what you book after the crossing, not on the crossing itself. Book the sailing early in the month, keep the tide table for the return, and leave the connection unbooked or refundable.'
      : hits.length === 2
        ? ' The two agree, so the simple reading holds.'
        : '';
  return {
    answer: `${hits.map((card) => card.text).join(' ')}${conclusion}`,
    sources: hits.map((card) => card.source),
    evidence: hits.map((card) => `${card.source}: ${card.text}`),
  };
}
