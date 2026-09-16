---
'@tollstile/mcp': minor
---

Ask the person at the client before charging a tool call. `paidTool(..., { approval })` sends an MCP elicitation and charges only when they accept: a declined or unanswered call releases its reservation, and a client that never declared elicitation is refused with `access_denied` instead of being charged silently. `above` skips the question for small amounts, and `unsupported: 'charge'` keeps charging clients that cannot ask.
