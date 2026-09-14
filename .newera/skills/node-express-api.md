---
name: node-express-api
description: Build and verify a Node backend API (Express/Fastify/Hono) with real tests on a Linux CI runner. Use when the brief asks for an API, backend, REST service, webhook receiver, or server. IMPORTANT — read the deploy note: an API is NOT static-hostable, so it cannot deploy through the static pages pipeline; build it, test it, and report that honestly.
---

# Node API (Express/Fastify/Hono) on a Linux runner

## Quick facts

- **Scaffold from zero:** `npm init -y` then `npm i express` (or `fastify`, or `hono`). Add `"type": "module"`, `engines: { node: ">=20" }`, and scripts: `dev` (node --watch), `test` (vitest).
- **Deploy reality (CRITICAL):** the deploy stage ships a STATIC directory. A long-running HTTP server is not static. Options: (a) build it + test it + state the deploy blocker honestly in `finish`, (b) if the product is mainly UI with a few endpoints, propose a static SPA with mock/api-less design, (c) suggest the user host the server separately. NEVER claim a deployed URL for an API.
- Node 20 + npm preinstalled. Prefer ESM (`import`) over CJS.

## The build loop

1. `npm install`
2. `node server.js` (or `npm run dev`) with `&`, then `curl -s localhost:3000/health`, then `kill %1` — the server must boot cleanly before adding routes.
3. Add routes in slices; after each slice: boot → curl each new route → kill. A route you never curled does not exist.
4. Tests: `npm i -D vitest supertest` and one spec per route group: `supertest(app).get("/health").expect(200)`. `npx vitest run`.
5. Typecheck (if TS): `npx tsc --noEmit`.

## Conventions

```
src/
  server.js|ts    ← app definition + export (separate from listen)
  routes/         ← route modules
  lib/            ← business logic, pure and testable
  middleware/     ← auth, logging
test/             ← *.test.ts
```

- **Export the app, listen conditionally**: `if (process.env.NODE_ENV !== "test") app.listen(port)` — supertest needs the app without the port.
- Validation at the boundary: check every input shape once in the route, keep handlers thin.
- Errors: one error middleware, consistent `{ error: string }` shape, real status codes.
- NEVER hardcode secrets — read `process.env`, document required vars in the README.

## Common failure → fix table

| Error | Fix |
|---|---|
| `EADDRINUSE` | previous server still alive — `pkill -f "node server"` before booting |
| `Cannot find module` | `npm install` or path typo (case-sensitive) |
| `SyntaxError: Cannot use import statement` | missing `"type": "module"` in package.json |
| Route returns 404 but looks defined | registered AFTER a catch-all, or wrong path prefix |
| Tests hang forever | missing conditional `listen` — supertest waits on an open handle; also close DB/db connections in afterAll |
| curl connects but hangs | async handler missing await/next — the response never sends |

## Pre-finish checklist

- [ ] boots clean, `curl /health` returns 200
- [ ] every route curled or covered by a supertest spec
- [ ] `npx vitest run` exits 0
- [ ] README documents run command + env vars
- [ ] finish summary states the static-deploy blocker explicitly (or the chosen alternative)