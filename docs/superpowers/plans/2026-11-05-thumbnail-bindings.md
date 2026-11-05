# Scoped thumbnail bindings implementation plan

Goal: Return Banktwo thumbnail bytes and declare exact source image bindings without changing raw article content or its hash.

Architecture: Preserve the Source Connector resource content and SHA-256. Add an optional `asset_bindings: [{source_url, resource_ref}]` sidecar using HTML-decoded image attributes; signed thumbnail references may carry only bounded locale/region queries in the same vehicle and fixed source origin. Keep article query rejection intact. AutoData must accept the sidecar before this connector is merged or deployed.

Tech stack: Node 22, TypeScript, Fastify, Vitest, htmlparser2.

- [x] Add failing regression tests for implicit/explicit legacy image reads and public image links.
- [x] Return image responses as bytes and mark rewritten image resource links binary.
- [x] Add failing resource tests for exact decoded image binding, unchanged content/hash, same-vehicle query round-trip, and unsafe query/origin rejection.
- [x] Add scoped signed thumbnail query validation and HTML attribute parsing; declare sidecar in OpenAPI.
- [x] Run npm test, npm run lint, npm run build, npm audit --omit=dev, and git diff --check; review the complete diff.
- [x] Commit and push coherent milestones, open a PR, and leave merge/deployment blocked on tolerant AutoData consumer delivery.

Verification: legacy route/link regressions failed before the first fix; source binding regression failed before sidecar implementation; credential-bearing source URL regression failed before validation. Full suite: 31 tests, lint, build and diff checks pass. Six production dependency advisories existed at the base SHA; a separate compatible dependency commit clears the audit. Production deployment remains blocked on delivery of the tolerant AutoData consumer. The retained thumbnail read-only probe returned image/jpeg, 22,412 bytes, with a matching hash; no production fetch/model job was started.
