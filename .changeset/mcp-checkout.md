---
'@tollstile/mcp': minor
---

Send a person to a page where they can pay. `paidTool(..., { checkout })` answers a denial the agent cannot act on — out of credit, no subscription — with MCP's URL elicitation, so the client shows its user a link instead of handing the model an error. Clients that cannot open one get the denial with the page in `_meta["tollstile/checkout"]`, and a client that can pay for itself is answered with its own payment challenge first.
