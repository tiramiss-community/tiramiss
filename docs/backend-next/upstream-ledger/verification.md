# 固定範囲での再現結果

実施日: 2026-11-18。fork入力: `741478fdba`。本家入力:
`d43954b333045e6c5fbd7e1b47592088980d5912..8e07cf085adf7009583d234a208e30436f020e26`。
この記録は形式の試行であり、SHA更新や製品全体のリリース可を示さない。

## Extraction

```sh
git merge-base --is-ancestor d43954b333045e6c5fbd7e1b47592088980d5912 8e07cf085adf7009583d234a208e30436f020e26
git log --reverse --format=%H d43954b333045e6c5fbd7e1b47592088980d5912..8e07cf085adf7009583d234a208e30436f020e26
git show --format=fuller 9916f7350eff12e2a67bdd952c44370f3f9acfda
git show --format=fuller 8e07cf085adf7009583d234a208e30436f020e26
git diff --no-renames d43954b333045e6c5fbd7e1b47592088980d5912 8e07cf085adf7009583d234a208e30436f020e26
node docs/backend-next/upstream-ledger/check.mjs
```

祖先関係: exit 0。履歴: 2 commits。最終差分: 4 paths。path filterは使っていない。
途中差分の全4 pathは最終差分にも残る。この範囲に途中で消えたpathはない。

| 本家コミット | 途中差分のpath | 台帳ID・読解結果 |
| --- | --- | --- |
| [9916f7350e](https://github.com/misskey-dev/misskey/commit/9916f7350eff12e2a67bdd952c44370f3f9acfda) | `packages/backend/src/models/UserProfile.ts` / `packages/backend/migration/1790477603333-UserProfilePasswordComment.js` | UL-001。EntityとDBコメントを一致させる1契約。DDLはCOMMENTのみ |
| [8e07cf085a](https://github.com/misskey-dev/misskey/commit/8e07cf085adf7009583d234a208e30436f020e26) | `Dockerfile` | UL-002。Dockerfile frontendとNode版のbuild/runtime契約 |
| 同上 | `packages/backend/test-federation/compose.tpl.yml` | UL-003。連合テスト環境のnginx版 |

抽出のPASSはGit一覧との一致と、この範囲の契約への分割を読んだ結果。
設定・依存・型・CI等は全体diffの4 pathに含まれるかを確認し、別の変更pathはなかった。
新backendへの対応完了やDocker/nginxでの動作検証を意味しない。

## UL-001

本家の要求はDBコメントの訂正。`varchar(128)`・nullable・値自体を変える差分ではない。
実現箇所は `packages/backend-upstream/src/models/UserProfile.ts` と
`packages/backend-upstream/migration/1790477603333-UserProfilePasswordComment.js`。

repo rootで以下を実行して、両方のbyte列が固定本家のGit blobと一致することを確認した。

```sh
python3 - <<'PY'
from pathlib import Path
import subprocess
sha = '8e07cf085adf7009583d234a208e30436f020e26'
for path in ['src/models/UserProfile.ts', 'migration/1790477603333-UserProfilePasswordComment.js']:
    expected = subprocess.check_output(['git', 'show', f'{sha}:packages/backend/{path}'])
    assert (Path('packages/backend-upstream') / path).read_bytes() == expected, path
    print('PASS exact blob:', path)
PY
```

結果: 2 blobともPASS。migrationの`up`はremote、`down`はlocalのCOMMENT文だけを実行すると読解した。
受入範囲を「定義の複製と全履歴への収録」に限定して対応済みとする。
DBでのmigration適用は実行していない。実DBの適用・schema検査は配布/切替の検証が所有し、この行で成功を主張しない。

## 未解決と持越し

UL-002は未評価。現在の旧DockerfileのNode版が一致していても、新backend配布物との関係と検証が未確定。
UL-003は要対応。旧fixtureのnginx文字列一致では新backendの連合動作を受け入れられないため、検証未了を残す。
BASE-138は既存Issue由来の持越し入力例。UL-002との関係を残し、今回の差分処理で消さない。
既存の全体残責任は [#114](https://github.com/tiramiss-community/tiramiss/issues/114) /
[#138](https://github.com/tiramiss-community/tiramiss/issues/138) /
[#139](https://github.com/tiramiss-community/tiramiss/issues/139) が引き続き所有する。

## 形式・判定の検証

```sh
node --test docs/backend-next/upstream-ledger/check.test.mjs
node docs/backend-next/upstream-ledger/check.mjs
node docs/backend-next/upstream-ledger/check.mjs --release
```

10件のテストは必須証跡の欠落・空文字/非文字列、途中path/最終path対応の欠落、持越し消失、判断根拠なしの影響なし・見送り・意図的差異、不明な状態を拒否し、固定Git範囲も照合する。
標準実行: exit 0、`record: PASS` / `delta: BLOCKED`。
release実行: exit 2、blockersは `UL-002` / `UL-003` / `BASE-138`。
全行を解決したテスト用入力でも `productReleaseApproved: false` を維持する。

製品全体のAPI・ジョブ・停止切替・配布物のテストをこの試行で実行したものではない。
