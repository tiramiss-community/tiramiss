# Instance read readiness correction (#361) implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this bounded documentation correction. The parent session owns independent review and publication.

**Goal:** Correct #361's mistaken ready classification without implementing partial APIs or absorbing the detailed-user work owned by other issues.

**Architecture:** Preserve the 2026-11-14 catalogue snapshot and add one dated currentCorrections overlay. Explain the source call graph and the minimal leaf dependencies in a separate audit; point current selection guidance to the correction.

**Tech Stack:** Markdown, JSON, standalone Python validation, existing repository checks.

**Spec:** [Readiness audit](../../backend-next/instance-read-361-readiness.md), fixed upstream `8e07cf085adf7009583d234a208e30436f020e26`, live #361/#195/#114 and #297/#338.

## Global constraints

- Worktree `s1-instance-read-361`, base `fa57cedcd7923e02144eedc4fbec50bbda8b333d`.
- No runtime, managed Entity, product proof or inventory status edits.
- Preserve every existing catalogue field, historical provenance/count and runtime evidence byte.
- No new Issue and no external mutation; #361 remains OPEN.
- Do not promote broad QueryService compatibility from a pagination source audit.

## Review focus

- Both relation endpoints populate followee, and following can reach the authenticated local followee.
- UserDetailedNotMe's schema name does not suppress the self branch.
- movedTo may resolve/create a remote actor; aliases only read saved actors.
- Page packing can write back legacy content, while peers must preserve stored rows.
- Snapshot counts and live selection must remain distinguishable after the correction.

## Task 1: Audit the dependency boundary

- [x] Read fixed six endpoint handlers, Instance/Following/User packers, pagination, Page pack and actor resolution.
- [x] Verify #293–#297 and #338 are OPEN and their scopes cover the required common/self materials.
- [x] Write `docs/backend-next/instance-read-361-readiness.md` with endpoint split, concrete self-reachable example and source links.
- [x] Stop product implementation before editing runtime; parent chose this correction after the dependency discovery.

## Task 2: Correct current planning views

- [x] Append a dated `currentCorrections` overlay in `docs/backend-next/backlog.json`: waiting, full consumer deps297+338, reduced native dep338.
- [x] Preserve snapshot `units`, `parents`, `counts`, `nativeDependencies` and provenance; explicitly tell consumers to overlay the correction.
- [x] Update BACKLOG/ROADMAP current selection to merged589/590/591 and the #361 correction, retaining historical progress sections.
- [x] Check the overlay's effective leaf/native/combined graphs, references, counts and historical object equality using a standalone command/report.
- [x] Prepare exact proposed #361 body/dependency update locally for parent review; do not publish it.

## Task 3: Validate and hand off

- [x] Validate local/source links and required fixed-source call patterns.
- [x] Run existing relevant inventory/root contracts and `node scripts/check-shipping.mjs --base fa57cedcd7923e02144eedc4fbec50bbda8b333d`.
- [x] Record PASS/FAIL/SKIPPED, exact commands/counts and limitations in the local report.
- [ ] Commit normally and return exact head and changed-file scope to parent; #361 runtime acceptance remains unimplemented.
