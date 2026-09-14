---
name: react-vite-spa
description: Build and verify a React (or Vue/Svelte/Solid) single-page app with Vite on a Linux CI runner. Use when the repo has package.json with `vite` and no `next`, or the brief asks for a lightweight React/Vite SPA, dashboard, or interactive client-side app. Covers scaffolding, the build loop, routing, and the static `dist/` output the deploy stage expects. Read BEFORE the first `npm install`.
---

# React + Vite SPA on a Linux runner

## Quick facts

- **Scaffold from zero:** `npm create vite@latest . -- --template react-ts` (also `react`, `vue-ts`, `svelte-ts`). Then `npm install`. Scaffold into the repo ROOT.
- **Deploy contract:** `npm run build` produces `dist/` with `index.html` — the static dir the deploy stage ships. Set `base: "./"` in `vite.config.ts` so asset URLs work under any host path.
- Node 20 + npm are preinstalled. Keep `package-lock.json` committed; use `npm ci`.

## The build loop

1. `npm install` (or `npm ci`).
2. `npm run build` — first build is the smoke test; it must be green before features.
3. Feature slices → rebuild after each. `npm run build` is fast (<60 s) — use it as your type checker (tsc runs first via `build: tsc -b && vite build` in the default scaffold).
4. Verify: `ls dist/` → `index.html`, `assets/`. `head -30 dist/index.html` sanity check.
5. Tests: `npm i -D vitest jsdom @testing-library/react` + one render spec of `App.tsx`; run `npx vitest run`.
6. Serve check: `npx vite preview --port 3000 &`, `curl -s localhost:3000 | head -20`, `kill %1`.

## Conventions

```
src/
  main.tsx        ← createRoot(<App/>) + global css import
  App.tsx         ← root component, router wiring
  components/     ← reusable UI
  pages/          ← route-level components
  hooks/          ← custom hooks
  lib/            ← pure logic
index.html        ← at ROOT (not src/) — Vite entry, <div id="root">
vite.config.ts    ← plugins, base: "./"
```

- Routing: `npm i react-router-dom` with `<BrowserRouter>`; nested `<Route element={<Layout/>}>` beats render-prop legacy syntax.
- Data fetching: `fetch` in `useEffect` for small apps; `@tanstack/react-query` when caching matters.
- NEVER put secrets in `import.meta.env.VITE_*` — they are baked into the bundle, public by design.
- Large assets → `public/` with absolute `/file.png` references, not imports.

## Common failure → fix table

| Error | Fix |
|---|---|
| `Cannot find module './App.jsx'` (TS build) | import path/extension mismatch — TS wants actual case (Linux is case-sensitive: `App.tsx` ≠ `app.tsx`) |
| Blank page after deploy | `base` not `"./"` — asset 404s under the host path |
| `process is not defined` | that's Node API in browser code — use `import.meta.env` |
| `[vite] Internal server error: Failed to resolve import` | dependency not installed or wrong relative path |
| tsc errors in `npm run build` but app runs in dev | type errors — dev server skips tsc; fix types, do not delete the tsc step |
| Assets 404 | referenced from `src/` as import instead of `public/` absolute path |

## Pre-finish checklist

- [ ] `npm run build` exits 0
- [ ] `dist/index.html` references `./assets/…`
- [ ] every interactive state (loading/error/empty/success) renders something real
- [ ] `npx vitest run` exits 0 (if specs were added)
- [ ] `request_deploy{subdomain, build_output_path:"dist"}` only after all of the above