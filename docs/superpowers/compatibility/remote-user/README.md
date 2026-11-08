# Remote-user fixed-source comparison inputs (#195 / next PR243)

These are **source-method observations**, pinned to upstream
`8e07cf085adf7009583d234a208e30436f020e26`. They are inputs for Task 2,
not evidence that the new runtime or the upstream HTTP server passes.
No product dependencies are required for the default validator:

```sh
node scripts/remote-user-contract.test.mjs
node --test scripts/remote-user-contract.test.mjs
```

The direct invocation avoids Node's test-runner child spawn in restricted sandboxes.
`node --test --test-isolation=none scripts/remote-user-contract.test.mjs` is another option.

## Importing and comparing

`observations.json` is standalone: `schemaVersion`, `upstreamCommit`, `methods`
(literal-source SHA256 fingerprints), `bindings`, `doubles`, `exclusions`, and
`cases`. Each stable case ID has `area`, `input`, `expected`, `methods`,
`provenance` and individually declared `doubles`. Import this JSON directly;
do not import the regeneration script or rewrite expected values in a second oracle.

```js
import { readFileSync } from 'node:fs';
const fixtures = JSON.parse(readFileSync(
  new URL('../../../../../docs/superpowers/compatibility/remote-user/observations.json', import.meta.url),
  'utf8',
)); // Adjust relative depth to the consuming file.
const selected = fixtures.cases.filter(c => c.area === 'actor');
const profileCase = fixtures.cases.find(c => c.id === 'actor-create-profile-key');
const expectedUser = profileCase.expected.events.find(e => e.op === 'User.save').args;
const expectedProfile = profileCase.expected.events.find(e => e.op === 'Profile.save').args;
const expectedKey = profileCase.expected.events.find(e => e.op === 'Key.save').args;
```

Expected is an independent projection: `{result, events}` or `{error, events}`;
resolve cases also expose retained `state`. Events preserve observable order.
A failed write event means an **attempt**, not a successful commit. Transaction
begin/commit/rollback events describe control flow through a transaction double.
`User.save`, `Profile.save`, `Key.save` contain constructor arguments; `.update`
events contain `{query, patch}`. They do not invent entity/database defaults.
Refresh returns `'skip'` even after successful core updates; compare its patches.
Use a consumer adapter to project actual results/writes into these shapes.

`{"$undefined":true}` encodes an own property with value undefined, including
TypeORM patches that omit an update; a missing JSON key means no own property,
and `null` means explicit null. Decode recursively when comparing raw objects,
or encode the actual projection with this convention. Dates are ISO strings.
The tag object is reserved by this schema. Input patches use the same convention.

The actor profile case uses intentionally tagged conversion doubles
(`converted:` / `field:`). Compare converted fields with the same injected
boundary at unit level; real HTML conversion and real database outcomes need
separate integration assertions. Never persist those tags in product data.

Declared consumers (Task 1 checks declarations; Task 3 checks actual consumers):

| Area | Planned consumer files |
| --- | --- |
| resolve | `packages/backend-next/test/unit/federation/remote-user.test.ts`, `packages/backend-next/test/unit/note/create-note.test.ts` |
| actor | `packages/backend-next/test/unit/federation/remote-actor.test.ts`, `packages/backend-next/test/integration/remote-user.test.ts` |
| fetch | `packages/backend-next/test/unit/federation/activity-fetch.test.ts` |
| publication | `packages/backend-next/test/unit/federation/local-actor.test.ts`, `packages/backend-next/test/integration/activitypub-actor.test.ts` |

Keep IDs stable when adding consumers. An intentional source-pin or behavior
change requires review of affected cases and their consumers, not blind regeneration.
The validator checks integrity, boundary declarations, selected outcomes and write
order; `--check` provides the full optional source replay comparison.

## Regeneration

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/source-probe.mjs --write
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/source-probe.mjs --check
```

By default the script reads `git show <pin>:<path>`. It extracts literal method
parameters and bodies using TypeScript AST, transpiles them and executes them in
VM contexts with explicit boundaries. Helpers execute their pinned source too;
the signer executes the extracted ApRequestCreator class, including private methods.
The route handler/negotiation are extracted AST bodies. No handwritten resolver
or actor implementation supplies expected values.

If Node's Git spawn is denied, use the byte-verified checkout fallback:

```sh
UPSTREAM_SOURCE_MODE=verified-files UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/source-probe.mjs --write
UPSTREAM_SOURCE_MODE=verified-files UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/source-probe.mjs --check
```

The fallback verifies Git blob hashes of **every read source file** against IDs
obtained from `git ls-tree -r 8e07cf085adf7009583d234a208e30436f020e26 packages/backend/src`.
It refuses changed/unpinned source bytes. Fingerprints and observations are the
same in either mode. The fallback was the executed path in this sandbox.

Regeneration explicitly resolves TypeScript from the upstream root's installed
node_modules, and node-html-parser, slacc, stringz, accepts and vary from that
checkout's backend installation. These are source-environment tools, never a
borrowed product dependency tree. No install, symlink or dependency-directory
modification is performed. slacc is initialized with one thread. The embedded
RSA private key is a public test fixture; SPKI export/signing/verification are real.
Observed environment: Node 24.20.0; repository `.node-version` requests 26.4.0.
This is not Node 26 verification.

## Scope and limits

Account cases cover local/self/IDN, first case-insensitive self link without MIME
filtering, cross-host new accounts, local self links, exact age boundaries,
pre-attempt timestamp/URI retention, missing self, WebFinger failure and invalid
repair. Mention occurrences independently resolve before ID deduplication; the
first identical occurrence fails while later occurrences and an alias succeed.
Actor cases execute validation and core creation/refresh for all five actor
types, optional key writes, profile fields/defaults, truncation, collection error
asymmetry, URL asymmetry, foreign sharedInbox stripping, duplicate recovery,
deleted skip and partial write failures. Missing key refresh attempts an UPDATE,
never insertion. Attachment and collection decisions execute literal methods.

Fetch cases execute resolver, signed/unsigned transport methods, content-type
and identity validation: context, history, exact recursion boundary, fragments,
www normalization, downgrade, mismatch and one same-host absolute alternate.
Alternate fetch failures are swallowed by the source's HTML catch, then the
original HTML content type fails. Recorded timeout/size are transport arguments;
actual streaming caps and timer cancellation are not measured. Signer lazy
acquisition and repeated resolution use the same resolver session. Local-user
resolution executes the literal local switch with supplied facts/rendering.

Publication executes source Accept quality negotiation, route suspension filter,
Vary, federation/missing/remote policies, cache and content type, then the literal
renderer projected to consumed signer/identity fields. System Application,
bot Service, local Person and deleted local rows are covered. `addContext` is
an identity double: this fixture makes no claim about the context envelope.
HTML routes fall through; HTML site rendering is excluded.

UtilityService host/policy predicates are supplied URL-based doubles; these cases
do not establish the full transitive UtilityService contract. Logger output is discarded.
All DB/HTTP/clock/token/conversion/transitive actor boundaries are named in the
dataset. Media, emojis, hashtags, cache/events, instance metadata/counts, charts,
featured and Move are incomplete external dependencies with explicit doubles;
these are **not compatibility PASS results**. No real PostgreSQL defaults,
constraints, rollback, actor concurrency, upstream HTTP, DNS/SSRF, TLS, streaming
limits, queue delivery, rich actor publication or full MFM parsing is established.
Task 2/3 must supply runtime/integration evidence separately. #195/#176/#127
remain incomplete; this task does not change product behavior or those statuses.
