# #272 finite posting proof reconciliation

Task intent is settled by #272 (`176-posting-proof`) and the reconciled design inputs. Baseline: `b4f28f6ceef458575f203c19d4ede37d7311468c`; fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. Work stays in isolated worktrees without runtime or configuration changes. Writers leave their diffs for the integrating parent, which owns commits and PR publication.

- [x] Read repository/package guides, GOALS/ROADMAP, shipping, Issue/PR and TDD skills; inspect design inputs and parent execution logs.
- [x] RED: require the absent current proof artifact; define integrity rejection cases before checker implementation.
- [x] GREEN: add shared evidence bindings and explicit subcontracts for all 62 contract / 59 audit IDs, C1–C10/F1–F8, preserving historical artifacts and classifications.
- [x] Add readable summary/reproduction, stale C2/C10 corrections, scoped inventory and ROADMAP references.
- [x] Run positive/negative checker tests, existing note/inventory checks and proportional shipping; record limits.

Keep `notes/create:partial`, `postingComplete:false`, D7 64-depth/256-Note, approved PG notification persistence and #176/#127 OPEN. Unproved utility/actor obligations stay with existing residual owners (#277/#322 and dependencies). No whole-service parity follows from a row or profile membership.


Validation (isolated writer, Node v26.4.0):

- PASS: absent-artifact RED was observed with `node --test --test-isolation=none scripts/note-contract-posting-proof.test.mjs` (explicit missing-artifact assertion); the current index is GREEN, 24 tests including 22 negative mutations.
- PASS: `node --check scripts/note-contract-posting-proof.test.mjs`; `node --test --test-isolation=none scripts/note-contract-posting-proof.test.mjs`.
- FAIL (environment): `node --test scripts/note-contract-*.test.mjs scripts/backend-contract-inventory.test.mjs`. Default child reporting failed 3 files; isolation-disabled diagnostics found existing historical `spawnSync` calls fail with sandbox EPERM, and inventory cannot import absent `typescript`. These are not reported as successful reruns. The inspected parent pre-change 93-test PASS remains separate evidence.
- SKIPPED (cannot start): `node scripts/backend-contract-inventory.mjs --check` needs absent `typescript`; `node scripts/check-shipping.mjs --base b4f28f6ceef458575f203c19d4ede37d7311468c` needs absent `execa`. No dependency install or configuration change was made.
- PASS: `node scripts/check-spdx.mjs` (`SPDX: OK`), `git diff --check`, NUL-safe changed-path locale check (zero non-Japanese locale YAML), source/inventory/historical-artifact preservation. Changed package ESLint target set is empty under the shipping script's rules (root structural script syntax checked above).

The existing runtime results were inspected from parent logs/receipt, not reexecuted by this writer: integration216/7, notifications14/1, process20/4, delete-process2/1, unit726/23; build/typecheck/sync exit0. The parent subsequently applied the three independently reviewed P2 fixes and reran the integrated Node suite: **122/122 PASS**, including the new checker's **29 tests**. Inventory `--check`, shipping SPDX/locale and diff checks passed (lint skipped: no targets). The writer-local limitations above remain historical and do not describe the integrated result. Finite index acceptance is reconciled; broad runtime completion is not claimed.
