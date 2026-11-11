# Local actor image publication (#195)

Publish local actor `icon` and `image` through existing public `GET /users/:id` and internal `acquireActor → resolveLocal`. Base: `62cdeb54289bdcf46ad57e7f8a28db8a4c5f2ee7` (PR #266). Source: `8e07cf085adf7009583d234a208e30436f020e26`. Scope follows `/tmp/tiramiss-s1-r9-selection.md`, GOALS, ROADMAP and the basic design's acquisition/projection boundary.

## Contract

Persistence includes nullable `avatarId`/`bannerId` and reads existing Drive rows independently by ID, without an owner predicate. Conditional avatar/banner reads start with the required profile in `Promise.all`; equal IDs still cause two reads. Missing rows fall back; rejected reads fail before tags/key. Composition acquires only plain file facts (`uri`, `userHost`, `isLink`, `webpublicAccessKey`, `webpublicUrl`, `url`, `isSensitive`, `comment`) and bounded Meta (`iconUrl`, `bannerUrl`, `proxyRemoteFiles`); no TypeORM entities reach business rendering.

Tags and key follow acquisition. Image URL conversion happens in actor construction after key retrieval. Found files produce `{type:'Image', url, sensitive:file.isSensitive, name:file.comment}` including null/empty values. No User.avatarUrl shortcut or avatar-thumbnail mode. Extract the existing mode-less `publicFileUrl` into Drive's narrow public contract without changing Note behavior: external proxy wins, then enabled linked-file `/files/<key>` only for a nonempty slash-free key, then `webpublicUrl ?? url`.

Ordinary missing avatar uses `${url}/identicon/${username.toLowerCase()}@${new URL(url).host}` (port retained); missing banner is explicit null. Dotted usernames identify system actors: non-null Meta icon/banner URLs produce Image objects, including empty URLs; null icon uses identicon, null banner stays null. Normalized `noteMedia` supplies production proxy defaults; when absent use `${new URL(url).origin}/proxy`, external proxy false. No new configuration keys.

Preserve early non-AP/federation-disabled/missing/remote-invalid/remote-redirect branches. Public excludes suspended local users; internal permits them and retains its existing remote-row rejection (upstream internal resolver instead casts that row). Meta remains a direct DB read: freshness and possible extra DB failures differ from upstream injected memory; cache parity is not claimed.

## Evidence and boundaries

Add a finite independent oracle executing literal pinned `renderPerson`, `renderImage`, `renderIdenticon`, `renderSystemAvatar`, `renderSystemBanner`, `getPublicUrl`, `getProxiedUrl`, URL query helpers and `getIdenticonUrl`. Verify complete source bytes against Git objects and hardcoded file/method SHA256s. Explicit DB/profile/Meta/config/tag/key doubles expose image JSON, reads and errors; expectations never come from backend-next. Exercise missing/either/both/shared/dangling IDs, ordinary/system/null/empty fallbacks, port/case, found-file fields, URL precedence and link-key branches, and competing Drive/profile/tag/key/conversion failures.

Unit consumers compare image JSON/errors to this additive corpus. Actual HTTP/isolated PG tests seed User/Profile/Key/Drive/Meta, observe internal documents via passthrough `validateActor`, and assert acquisition plans and retained rows. Test early branches, suspended distinction, normalized/default proxy, cross-owner files and Drive DB faults before tag/key work. Run closest Note media callers after extraction. Source-method doubles, new-server real PG/HTTP, and upstream full-server evidence remain explicitly distinct.

No Drive acquisition, media policy invention, lifecycle changes, schema/entities, SDK/API metadata, locales, CHANGELOG, inventory/audit/domain/ROADMAP or root evidence helpers. Historical probes/observations/evidence stay byte-for-byte unchanged. Additive probe/corpus/results only. `/identicon`, `/files`, `/proxy` byte-serving routes remain unimplemented; URL publication does not prove image delivery. #176/#127/#195 remain partial, `notes/create:partial`, `postingComplete:false`.

## Execution and validation

One cohesive implementation task, single writer, no child agents/Git mutations/install/auth/config/Docker/external sends. Plan approval uses `/tmp/tiramiss-s1-r9-plan-approved.json`. RED precedes product edits. Parent runtime broker checks frozen input hashes before/after each command and writes a receipt; all inputs stay frozen until receipt. Results bind the exact receipt and measured input hashes at that measurement time, without promising future whole-checkout immutability. Parent owns shipping/root contracts/CodeRabbit/reviews/commits/PR.
