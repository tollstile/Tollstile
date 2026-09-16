---
'@tollstile/mcp': patch
---

Say the checkout page in the content a model reads, not only in `_meta`. A client that cannot open a URL usually renders no `_meta` either, so its user was told the tool failed and never saw where to pay. The message and the URL are now the result's first content block; the denial body follows in the next one, and `_meta` is unchanged.
