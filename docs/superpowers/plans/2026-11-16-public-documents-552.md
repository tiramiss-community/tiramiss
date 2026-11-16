# #552 public documents implementation

Scope: port the fixed upstream manifest, robots and OpenSearch responses. Existing Meta cache supplies a narrow snapshot; pure rendering belongs in `modules/public-documents`, Hono headers and errors in `http/public-documents-api.ts`, runtime wiring in `composition/public-documents-http.ts` and `http-app.ts`. No new dependencies, static assets, SPA or SSR.

1. Capture the pinned upstream methods and route callbacks through real listening Fastify HTTP for default, configured, special-character, visitor-visibility and valid/invalid override cases. Save corpus, literal source provenance and observed responses.
2. Write failing HTTP tests consuming those observations; implement pure renderers and the HTTP adapter. Preserve shallow JSON spread, fallback distinctions and source error behavior. Connect the existing Meta reader and verify composition route registration.
3. Run the same corpus through ordinary composition with real PostgreSQL, Redis and listening HTTP. Verify cached settings and notified changes. Run build, typecheck, nearby tests and repository contracts.
4. Preserve historical proofs with a bounded predecessor projection only for the two changed shared composition inputs; retain immutable previous evidence. Update only #552's nine inventory and six audit rows, documenting that administrative mutation and static assets remain separate.
5. Finish shipping checks, freeze all inputs and request the independent branch review through the coordinator. Commit/push only on coordinator instruction.
