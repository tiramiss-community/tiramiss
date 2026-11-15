# Meta cache synchronization (#317)

Fixed source: Misskey `8e07cf085adf7009583d234a208e30436f020e26`, `MetaService.ts`. Parent #217, prerequisite #290. User delegated implementation choices; these are implementer decisions.

The process owns one cache subscribed to the existing internal event receiver. `fetch(false)` returns a warm value; `fetch(true)` queries the existing newest-ID/empty-row reader and replaces the cache. `metaUpdated` replaces it with `body.after` and `rootUser: null`. Normal processes reload every 300000ms; tests opt in to the timer explicitly. Closing cancels the timer, unregisters the consumer and waits for reads already started. Timer failures are reported without an unhandled rejection; explicit reads reject. No Redis-to-DB degradation mode or update-meta API is introduced.

Approaches considered: retaining DB reads does not satisfy the notification/hit contract; invalidating on notification differs from source's authoritative after payload; replacing from after matches source and is selected. Fetches are not coalesced or version fenced: source allows an older in-flight read to replace a newer notification. Tests make this limitation explicit. The database reader keeps transaction ownership with callers and preserves concurrent empty initialization.

Runtime composition routes actor discovery/materials/registration, AP sibling endpoints and delivery decisions through this process cache. Other feature-specific database material readers remain outside this slice. Existing historical receipts remain unchanged; new finite source observations and real PG/Redis/HTTP evidence describe exactly this slice.
