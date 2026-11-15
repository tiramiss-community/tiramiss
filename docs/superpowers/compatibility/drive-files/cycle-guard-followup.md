# Mixed folder snapshot cycle follow-up

Web review on PR #596, comment4577086929, identified a cycle in the newly acquired folder material: separate reads can observe `child → parent` and `parent → child` across legal concurrent folder moves. A loop that stops on any already-acquired folder treats that same-path repetition as ordinary shared-ancestor reuse; the pure recursive renderer then overflows the stack.

The adapter now tracks the current root's path and rejects a repeated ID in that same path before rendering. The global material map still deduplicates shared ancestors across different roots. There is no retry, stronger snapshot isolation, persistent state or change to ownership/query error handling.

This retains HTTP `INTERNAL_ERROR` status500 for inconsistent material, with the controlled diagnostic `Drive folder hierarchy contains a cycle.` instead of a stack-overflow diagnostic. Pinned source folder packing recursively loads ancestors rather than rendering this captured graph, so its repeated reads may observe a later state; no new source-equivalence claim is made for this concurrent mixed-snapshot boundary. The accepted boundary is a bounded internal failure for the request instead of unbounded recursion, with a normal next read succeeding once consistent material is available.

Two adapter tests distinguish same-path cycles from safe shared-ancestor reuse. A real authenticated HTTP/PG regression injects the mixed parent snapshot, asserts the controlled500 and checks that the next ordinary read succeeds. Both the adapter and HTTP cycle regressions were observed failing with `Maximum call stack size exceeded` before the guard.

The original runtime `34a415ea2ad63d86efd8d650117ef71c1e8c63fc` and its `run-results.json` stay historical and unchanged. This follow-up has its own runtime/input/run record; it does not relabel the original run as measuring the guard. The strict three-file historical projection is unchanged because none of those three inputs changed in this fix.
