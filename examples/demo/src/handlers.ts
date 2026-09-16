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
