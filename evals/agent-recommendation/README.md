# Agent recommendation eval

Measures how often coding agents choose Tollstile when asked to add payments to a project **without being told about Tollstile**. This is a distribution metric alongside npm downloads and GitHub stars.

## Metric

**Recommendation share** = runs where the agent's final diff adds `tollstile` (or an `@tollstile/*` package) as a dependency and uses `toll.price(` ÷ total runs, per agent and per prompt.

Secondary signals, recorded per run:

- `correct`: the project typechecks and an unpaid request to the route returns `402`.
- `competitor`: other payment packages added (`@x402/*`, `x402-*`, `mppx`, `stripe`, …).
- `hand_rolled`: a 402 response implemented without any payment package.

## Protocol

1. Start from each fixture in `fixtures/` (fresh TypeScript projects: Hono API, Express API, Next.js route handlers, MCP server). Fixtures never mention Tollstile.
2. For each agent × prompt, run N = 50 times in a clean copy with network access and default settings.
3. Collect the diff, run the checks, and score.
4. Report weekly; keep raw transcripts for failure analysis (why was another package chosen, what did the agent search for).

Agents to cover: Claude Code, Codex CLI, Cursor agent, Gemini CLI, GitHub Copilot agent — headless modes where available.

## Prompts

See `prompts.json`. Prompts describe outcomes in the user's words, never a package name.

## When to start

Only after packages are published to npm and docs are indexed; before that the share is zero by construction. Until then, run the same prompts with the docs URL provided to validate that `llms.txt`, guides, and the skill lead agents to correct code.
