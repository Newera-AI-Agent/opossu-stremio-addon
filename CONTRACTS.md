# CONTRACTS

AUTO-GENERATED after every successful file write. Do not edit by hand - your edits will be overwritten.

This is the authoritative list of what exists in this project. If a symbol is not listed here and not in a file you have read during this run, IT DOES NOT EXIST. Do not reference it. Read the file or write the symbol first.

## Dependencies (package.json)

- `@types/express` `^5.0.3`
- `@types/node` `^24.3.0`
- `@types/supertest` `^6.0.3`
- `express` `^5.1.0`
- `supertest` `^7.1.4`
- `tsx` `^4.20.5`
- `typescript` `^5.9.2`
- `vitest` `^3.2.4`

Scripts: `dev`, `build`, `start`, `test`, `typecheck`

## Files and public API

### `public/index.html` - 28 lines
- exports: (nothing public)

### `src/app.ts` - 15 lines
- imports: `src/catalog.ts`, `src/sources.ts`, `src/types.ts`
- `app` (const)

### `src/catalog.ts` - 8 lines
- imports: `src/types.ts`
- `catalog` (const)
- `findItem` (const)

### `src/sources.ts` - 16 lines
- imports: `src/types.ts`
- `ConfiguredLegalSource` (class): baseUrl, constructor, label, streamsFor

### `src/types.ts` - 5 lines
- `CatalogItem` (interface): id
- `LegalStream` (interface): title
- `LegalSourceAdapter` (interface): label
- `MediaType` (type)

### `test/app.test.ts` - 12 lines
- imports: `src/app.ts`
- exports: (nothing public)

## Unresolved references

- (none) - every internal import resolves.
