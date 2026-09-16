---
'@tollstile/mcp': patch
---

Put the checkout page on screen through form elicitation when the client cannot open a URL. No client measured so far declares `elicitation.url` — Claude Code 2.1.186 declares only `form`, and renders it as a dialog — so the page now falls back from url mode to form mode before it falls back to text. A client that fails to show the question still gets its denial.
