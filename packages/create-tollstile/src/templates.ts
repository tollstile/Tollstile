export type TemplateFile = { readonly path: string; readonly contents: string };

export function honoTemplate(name: string): readonly TemplateFile[] {
  return [
    {
      path: 'package.json',
      contents: `${JSON.stringify(
        {
          name,
          private: true,
          type: 'module',
          scripts: {
            dev: 'tsx watch src/server.ts',
            agent: 'tsx src/agent.ts',
          },
          dependencies: {
            '@hono/node-server': '^1.13.0',
            '@tollstile/hono': '^0.1.0',
            hono: '^4.6.0',
            tollstile: '^0.1.0',
          },
          devDependencies: {
            '@types/node': '^22.0.0',
            tsx: '^4.19.0',
            typescript: '^5.9.0',
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'tsconfig.json',
      contents: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ['src'],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'src/toll.ts',
      contents: `import { createTollstile, memoryLedger, testRail } from "tollstile";

// The test rail runs the whole payment lifecycle locally: no wallet, network, or account.
// Swap in real rails (x402, MPP, …) and a database ledger when you deploy.
export const toll = createTollstile({
  rails: [testRail()],
  ledger: memoryLedger(),
});
`,
    },
    {
      path: 'src/server.ts',
      contents: `import { serve } from "@hono/node-server";
import { tollstile } from "@tollstile/hono";
import { Hono } from "hono";
import { toll } from "./toll.js";

const app = new Hono();

app.get("/", (c) => c.text("GET /weather costs $0.01. Run \`npm run agent\` to pay for it."));

app.get("/weather", tollstile(toll.price("$0.01")), (c) => {
  return c.json({ forecast: "clear", paidWith: c.get("payment").via });
});

serve({ fetch: app.fetch, port: 3000 }, ({ port }) => {
  console.log(\`Paid API listening on http://localhost:\${port}/weather\`);
  console.log("In another terminal, run: npm run agent");
});
`,
    },
    {
      path: 'src/agent.ts',
      contents: `// A tiny agent that meets a 402, pays with the test rail, and gets through.
const url = process.argv[2] ?? "http://localhost:3000/weather";

type Challenge = { price: string; accepts: { rail: string }[] };

console.log(\`→ GET \${url}\`);
const unpaid = await fetch(url);
console.log(\`← \${unpaid.status} \${unpaid.statusText}\`);

if (unpaid.status !== 402) {
  console.log("Expected 402 Payment Required. Is the server running?");
  process.exit(1);
}

const challenge = (await unpaid.json()) as Challenge;
console.log(\`  price \${challenge.price} · rails \${challenge.accepts.map((offer) => offer.rail).join(", ")}\`);

// An Idempotency-Key makes the paid request safe to retry: a retry is never paid or run twice.
console.log(\`→ GET \${url}  (Payment: test, Idempotency-Key)\`);
const paid = await fetch(url, { headers: { payment: "test", "idempotency-key": crypto.randomUUID() } });
console.log(\`← \${paid.status} \${paid.statusText}\`);
console.log(\`  receipt \${paid.headers.get("payment-receipt") ?? "none"}\`);
console.log(\`  \${await paid.text()}\`);
`,
    },
    {
      path: 'README.md',
      contents: `# ${name}

A paid API built with [Tollstile](https://tollstile.com).

\`\`\`bash
npm install
npm run dev     # starts the API on :3000
npm run agent   # in another terminal: 402, pay, 200
\`\`\`

- \`src/toll.ts\` — rails and ledger.
- \`src/server.ts\` — \`GET /weather\` costs $0.01.
- \`src/agent.ts\` — a test agent that pays with the test rail.

Next: read the [quickstart](https://tollstile.com/docs/quickstart) and replace the test rail with a real one.
`,
    },
    {
      path: '.gitignore',
      contents: 'node_modules\n.env\n',
    },
  ];
}
