import { writeFileSync } from 'node:fs';
const all = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let offset = 0; ; offset += 100) {
  const response = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&offset=${offset}`);
  if (!response.ok) { console.log('stopped at', offset, response.status); break; }
  const body = await response.json();
  all.push(...body.items);
  if (offset === 0) console.log('total advertised', body.pagination.total);
  if (body.items.length < 100 || all.length >= body.pagination.total) break;
  if (offset % 2000 === 0) console.log(' …', all.length);
  await wait(120);
}
writeFileSync(process.env.OUT ?? `./snapshots/bazaar-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(all));
console.log('saved', all.length);
