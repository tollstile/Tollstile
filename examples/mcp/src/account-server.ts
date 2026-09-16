import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { paidTool } from '@tollstile/mcp';
import { createTollstile, credits, memoryBalance, memoryLedger, subscriber, testRail } from 'tollstile';
import { z } from 'zod';

/**
 * A paid MCP server for people, not for wallets. No client in wide use lets a model attach a
 * payment to a tool call — but every remote MCP client signs its user in. So the caller is
 * identified, the call draws on what they already bought, and running out sends them to a page.
 */
const CREDITS_PAGE = 'https://weather.example/account/credits';

/** Stand-ins for your own database: who a token belongs to, what they have bought. */
const accounts: Record<string, string> = { 'token-amy': 'acct_amy', 'token-ben': 'acct_ben', 'token-dee': 'acct_dee' };
const subscriptions = new Set(['acct_dee']);
const balance = memoryBalance({ acct_amy: '$2.00' });

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });

export function createAccountServer(): McpServer {
  const server = new McpServer({ name: 'weather', version: '1.0.0' });

  paidTool(
    server,
    'forecast',
    { description: "Tomorrow's weather for a city. $0.01 from your balance.", inputSchema: { city: z.string() } },
    // No payPerCall(): there is no way into this tool except an account. A caller holding a valid
    // payment proof is refused like anyone else.
    toll.price('$0.01', {
      access: [subscriber({ active: (principal) => subscriptions.has(principal.id) }), credits({ balance })],
    }),
    ({ city }) => ({ content: [{ type: 'text', text: `Tomorrow in ${city}: clear` }] }),
    {
      principal: (extra) => {
        const account = accounts[extra.authInfo?.token ?? ''];
        return account === undefined ? null : { id: account };
      },
      // Out of credit is not an error for the model to retry: it is an errand for the person.
      checkout: (denial) => (denial.error.code === 'access_denied' ? { url: CREDITS_PAGE, message: 'Add credit to keep using the weather tools.' } : null),
    },
  );

  return server;
}
