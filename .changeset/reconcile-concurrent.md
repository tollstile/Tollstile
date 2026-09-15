---
'tollstile': patch
---

reconcile() no longer aborts when another worker moves a charge first: the transition conflict is skipped and the run continues. Verified with two concurrent reconcile workers on PostgreSQL.
