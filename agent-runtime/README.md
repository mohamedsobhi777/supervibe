# agent-runtime

Standalone (Bun-native) agent process — `worker/` code it imports is typechecked separately by the root `tsc -b` (Workers project); run `bun run typecheck:agent-runtime` here instead of adding this package to the root typecheck, since one tsconfig cannot cleanly typecheck both Bun-native and Workers-native (`?raw` imports, container bindings) code at once.
