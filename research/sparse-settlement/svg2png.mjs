import { chromium } from './film/node_modules/playwright-core/index.mjs';
import { readFileSync } from 'node:fs';
const exe = process.env.CHROME;
const b = await chromium.launch({ executablePath: exe });
const pg = await b.newPage({ viewport: { width: 760, height: 520 }, deviceScaleFactor: 2 });
await pg.setContent(`<body style="margin:0">${readFileSync('fig-region.svg','utf8')}</body>`);
await pg.screenshot({ path: 'fig-region.png' });
await b.close();
