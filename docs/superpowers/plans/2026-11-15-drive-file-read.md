# Drive file reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete #279's five file read endpoints and pure shared packing.
**Architecture:** Drive owns plain file facts, lookup UseCases and pure projection; TypeORM preloads folder/user materials; HTTP binds auth/errors.
**Tech Stack:** TypeScript, Hono, TypeORM, Vitest, PostgreSQL/Redis.
**Spec:** docs/superpowers/specs/2026-11-15-drive-file-read-design.md

## Global Constraints

- Pinned upstream `8e07cf085adf7009583d234a208e30436f020e26`; no old-backend/managed-upstream edits.
- Use acquired materials for pure rendering; preserve DB failures.
- Own compose project/ports; no CHANGELOG or unrelated inventory changes.

## Review Focus

- ID takes precedence when both ID and URL exist, including malformed ID plus valid URL.
- Cross-owner and missing rows distinguish denied from missing without weakening scoped tokens.
- Missing folder/user preload must fail rather than silently omit requested details.
- Admin owner moderator header redaction includes conditional/expired roles.
- Self original URLs/raw orientation and public remote thumbnails remain distinct.

### Task 1: Shared pure packing

Files: create `src/modules/drive/file-view.ts`, `test/unit/drive/files.test.ts`; modify `src/platform/database/note-files.ts` and Drive public exports.
Produces: `renderDriveFile(file, proxyRemoteFiles, options, packing, materials)`; plain facts and pack options; `validateFileName(name)`.

- [ ] Write tests for self/public properties/URL, withUser/detail preload, single versus nullable userId, valid/invalid names.
- [ ] Run `pnpm --filter backend-next test test/unit/drive/files.test.ts` and observe missing-feature failures.
- [ ] Extract existing note projection into pure Drive renderer and keep note wrapper using nullable semantics.
- [ ] Run new tests and `test/unit/note/files.test.ts` → PASS.

### Task 2: Read UseCases and HTTP adapters

Files: create `src/modules/drive/files.ts`, `src/platform/database/drive-files.ts`, `src/composition/drive-files-http.ts`, `src/http/drive-files-api.ts`, `test/unit/drive/file-read.test.ts`, `test/integration/drive-files.test.ts`; modify `src/composition/http-app.ts`.
Consumes Task 1 renderer. Produces `createDriveFiles(ports)` with show/find/findByHash/checkExistence/adminShow plus endpoints.

- [ ] Add failing unit and HTTP tests for five endpoint queries, auth/input/errors, pure preloaded folder/user output and admin header redaction.
- [ ] Observe failures, implement UseCases and TypeORM preload, then bind to ordinary HTTP composition.
- [ ] Dedicated compose `backend-next-279` DB55279/Redis56279; run real HTTP tests and note-show/files regressions → PASS.
- [ ] Add fixed-upstream source comparison for lookup/pack/validation/admin output; run → PASS, record source-method versus real DB evidence separately.

### Task 3: Evidence and delivery

- [ ] Write compatibility results with exact commands, scope and limits; update only #279 owned inventory rows if complete proof supports it.
- [ ] Run upstream sync check, backend-next build/typecheck, complete unit command and shipping checks → PASS.
- [ ] Commit implementation/evidence without push; provide parent report and independent-review handoff. Parent controls review/PR.
