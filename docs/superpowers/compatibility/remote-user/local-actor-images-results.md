# Local actor icon/banner publication (#195)

Public `GET /users/:id` and the existing internal `acquireActor → resolveLocal` now publish local actor `icon` and `image` from existing Drive rows. Composition acquires independent avatar/banner reads alongside the required profile, then bounded Meta/config facts. Tags and key follow; URL conversion occurs during pure actor construction after the key. The business renderer receives plain materials. Shared mode-less Drive URL projection preserves existing Note packing.

The [design](../../specs/2026-11-11-local-actor-images-design.md) and [plan](../../plans/2026-11-11-local-actor-images-195.md) define this limited slice. Missing/dangling images, shared IDs, cross-owner files, found-file sensitivity/null/empty comments, dotted system usernames, null versus empty Meta URLs, lowercase identicons with configured ports, and external-proxy/link/stored URL precedence are covered. Non-AP, disabled, missing and remote branches remain early; public suspended exclusion differs from internal local acceptance.

## Independent pinned source

The additive [corpus](local-actor-images-corpus.json), [observations](local-actor-images-observations.json) and [probe](local-actor-images-source-probe.mjs) cover **33 cases** (26 successful image projections, 7 errors). The probe executes literal `renderPerson`, `renderImage`, the actual identicon/system fallback methods, `getPublicUrl`, `getProxiedUrl`, URL query helpers and `getIdenticonUrl` from pin `8e07cf085adf7009583d234a208e30436f020e26`. Four complete Git-object byte comparisons and SHA256/method fingerprints guard the consumed source. Repository/profile/Meta/config/tag/key doubles are explicit; no expected image JSON comes from the new implementation. This is source-method evidence, not an upstream full-server run.

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-actor-images-source-probe.mjs --check
```

## Adopted runtime measurement: revision 2

Base `62cdeb54289bdcf46ad57e7f8a28db8a4c5f2ee7`, uncommitted implementation; Node26.4.0 / pnpm12.9.1. The parent broker used isolated PG55512/Redis56412/Meili57812. [Runtime evidence](local-actor-images-runtime-evidence.json) binds exact commands, log/artifact hashes, 21 current input files and 25 preserved historical JSON/probe hashes to the actual receipt.

| Check | Actual adopted result |
| --- | --- |
| Dependency-order build and typecheck, including all test types | PASS / exit0 |
| Focused modified/nearest actor, config and Note media units | 317 PASS, 10 files, 0 failures/skips |
| Actual mounted actor HTTP + isolated PG + internal acquisition | 53 PASS, 1 file, 0 failures/skips |
| Actual remote-user HTTP/PG regression | 108 PASS, 1 file, 0 failures/skips |
| Pinned source replay | 33 identical cases, exit0 |
| Changed-file ESLint / SPDX / diff check | PASS |

Adopted receipt `/tmp/tiramiss-s1-r9-validation-receipt-r2.json`, SHA256 `89f9c88c2b9a17155ab2a4cd4857152c4ec2df05bd77a9b4d4b1cf9e1174cf7c`. Its window is **2026-11-11T09:56:01.464832+00:00 → 2026-11-11T09:56:29.559534+00:00**. Request `/tmp/tiramiss-s1-r9-validation-request-r2.json`, SHA256 `067fa0a74a6931662870c1554eb0a6b7898625f8129ad755fad1afd44e58bc7c`, fixes **835** actual source/config/test/oracle inputs. The broker checked all hashes before/after each command. This records those inputs at that measurement time; later Markdown/evidence or parent metadata/root-helper work is outside that set, and no future whole-checkout immutability is promised.

Actual HTTP/PG cases seed User/Profile/Key/Drive/Meta, run both real compositions, observe the actual internal actor document through passthrough `validateActor`, then verify the returned acquisition plan and retained rows. Normalized/default and absent optional media configuration, ports, system fallbacks, stored-file precedence, shared/dangling/cross-owner IDs and early/suspended/redirect branches are covered. Dangling historical references use transaction-local disabled FK triggers only in the isolated fixture, restored at transaction end. The Drive fault uses real PG division-by-zero (22012), then actual Drive SQL on the aborted transaction (25P02); both callers fail before tags/key, HTTP errors are uncached, and rows remain intact. No schema is changed by that fault.

The initial behavioral RED is retained at `/tmp/tiramiss-s1-r9-red-images.log`: **24 intended missing-icon/image failures before product edits**. The local sandbox integration attempt remains **ENVIRONMENT_FAIL**, `connect EPERM 127.0.0.1:55512`, 50 skipped at that earlier revision (`/tmp/tiramiss-s1-r9-local-integration-attempt.log`). Neither is relabeled PASS. R1's successful earlier measurement remains unchanged; after receipt only the Drive fault test was strengthened, and R2 reran all six commands. An exploratory synchronous Git subprocess also failed EPERM; asynchronous Git verification subsequently succeeded and is used by the final probe. Existing `pg` concurrent-query deprecation warnings remain in the logs.

## Limits and remaining work

Meta remains a direct DB read, with freshness and additional failure differences from upstream injected memory. The existing internal remote-row rejection remains; upstream casts that row. No cache or whole-actor parity is claimed. Historical corpora/probes/evidence remain byte-for-byte unchanged; historical identity tests project out the newly covered images and the additive corpus owns their assertions.

Publishing compatible URLs does **not** prove image-byte delivery: `/identicon`, `/proxy`, `/files` serving routes remain unimplemented. Drive acquisition and remote media, featured/remote Notes/inbox, Follow paths, Move, remaining instance/chart/cache work remain with their existing owners. Ordinary local mention resolution can bypass this renderer. #176/#127/#195 remain partial, `notes/create:partial`, `postingComplete:false`.

No schema/entity/lifecycle, SDK/API metadata, locale, CHANGELOG, inventory/audit/domain/ROADMAP or root evidence-helper edits were made in this implementation lane. Full unit/process suites were skipped proportionally: no process or resource-lifetime contract changed; dependency-order typecheck covers the required renderer/materials signatures and the closest consumers were exercised. Parent owns shipping/root contracts, source review, CodeRabbit, implementation commit/pin, metadata and PR; the runtime receipt does not claim these gates passed.
