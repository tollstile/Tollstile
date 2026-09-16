---
'tollstile': minor
---

Spread the wait a `retry_later` denial asks for, and put it in the body. `Retry-After` was a fixed five seconds, so a hundred clients denied at the same instant came back at the same instant; it is now spread around five, and the same number is carried as `retryAfter` (seconds) in the denial body, which is how an MCP client — which never sees HTTP headers — can honour it at all.
