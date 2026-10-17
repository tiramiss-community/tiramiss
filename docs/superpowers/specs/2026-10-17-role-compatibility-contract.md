# Role初期実装の本家仕様・公開契約・互換性の期待値

日付: 2026-10-17。対象: [#116](https://github.com/tiramiss-community/tiramiss/issues/116)。親: [#115](https://github.com/tiramiss-community/tiramiss/issues/115)、[全体計画 #114](https://github.com/tiramiss-community/tiramiss/issues/114)。

前提は[基本設計](2026-10-15-misskey-backend-redesign-design.md)と[Role詳細設計](2026-10-16-role-policy-update-design.md)。本書は合意済みの境界を具体化し、後続の #117–#121 が使う契約と期待値を記録する。Role業務実装や新旧一致の検証完了を意味しない。

## 1. 比較基準と根拠

本家コミットを `8e07cf085adf7009583d234a208e30436f020e26` に固定する。現在のforkの作業ツリーを参照基準にしない。以下のパスはすべてそのコミット基準。

| 根拠 | 確認対象 |
| --- | --- |
| `packages/backend/src/server/api/endpoints/admin/roles/{show,update}.ts` | 認可条件、入力、対象なしのエラー |
| `packages/backend/src/server/api/{ApiServerService,ApiCallService,AuthenticateService,endpoint-base,error}.ts`、`src/misc/token.ts` | HTTP、認証、scope、検証、エラー形式 |
| `packages/backend/src/core/{RoleService,IdService}.ts` | 条件、期限、集約、資格、更新、副作用、ID由来の日時 |
| `packages/backend/src/core/entities/RoleEntityService.ts` | showの出力と割り当て人数 |
| `packages/backend/src/core/ModerationLogService.ts`、`src/models/ModerationLog.ts`、`src/types.ts` | 監査の保存形式と削除連鎖 |
| `packages/backend/test/unit/RoleService.ts` | 本家が持つ47件のRoleテスト |

実行用の追加probe、機械可読のHTTPケース、既定ポリシー全件は[比較資料](../compatibility/role/README.md)へ置く。参照checkoutの本家ソースを改変せず、追加のテストだけをコピーして実行する。コード読解で確認した事項とprobeの実行範囲は第8節で区別する。

## 2. HTTP APIの契約

### 2.1 受付・認証・認可の順序

対象は `/api/admin/roles/show` と `/api/admin/roles/update`。互換性ケースはJSON POSTを使用する。両APIとも `allowGet` がなく、GETは405・空本文。その他のHTTPメソッドまで一律にPOST以外拒否へ変更しない。本家は `fastify.all` で登録する。

1. `Authorization` が大文字小文字を区別する `Bearer ` で始まれば、その後ろをトークンとする。それ以外は本文の `i` を使う。Bearerが無効でも本文へ再試行しない。null・未指定を除く非文字列のトークンの扱いは§7の意図的な修正に従う。
2. トークン長16なら `user.token` でユーザーを特定する。他は `access_token.hash = token.toLowerCase()` または `access_token.token = token` で検索する。Appに紐づく場合は `app.permission`、それ以外は `access_token.permission` を使う。AccessTokenの `lastUsedAt` 更新は本家では待機しない。
3. 未認証とサスペンドを拒否する。rootもサスペンドを免除されない。
4. `show` はモデレーターまたは管理者、`update` は管理者。rootはこの資格判定を免除される。ポリシーの `canManageCustomEmojis` 等で代替しない。
5. AccessTokenには `show: read:admin:roles`、`update: write:admin:roles` の完全一致scopeを要求する。rootでもscopeは必要。native tokenにはscope検査をしない。
6. 入力の検証、対象ロールの存在確認、処理の順。認可がない実行者へ入力不備・対象の有無を先に返さない。

新実装の更新認可は、詳細設計§3.3に従いUseCaseがトランザクション内のDB情報を使う。HTTPの資格キャッシュだけで認可を完了させない。トークンの解決とscopeからの操作許可の解釈はHTTP認証アダプタが行い、認証済みActorのcredentialGrantへ渡す。scope不足だけでHTTPが先に拒否せず、UseCaseがサスペンド・資格を確認した後にcredentialGrantを検査する。これにより資格不足とscope不足の同時発生時も本家の拒否順を維持する。

### 2.2 入力と保存

| フィールド | show | update | 省略・nullの扱い |
| --- | --- | --- | --- |
| `roleId` | 必須 | 必須 | 英数字1文字以上。省略・null・記号入りはINVALID_PARAM。長さ固定を追加しない |
| `name`, `description` | — | string | 省略は保持。null不可。APIに長さ・非空の制約はない |
| `color`, `iconUrl` | — | string または null | 省略は保持、nullは消去。色・URL形式の検証を追加しない |
| `target` | — | `manual` / `conditional` | 省略は保持、null不可 |
| `condFormula`, `policies` | — | object | 省略は保持、null不可。内部構造・既知キー・値域をAPIは検証しない |
| `isPublic`, `isModerator`, `isAdministrator`, `isExplorable`, `asBadge`, `preserveAssignmentOnMoveAccount`, `canEditMembersByModerator` | — | boolean | 省略は保持、null不可 |
| `displayOrder` | — | number | 省略は保持、null不可。APIではinteger指定ではない |

更新の入力には既定値がない。`policies` と `condFormula` は指定されたobject全体の置換であり、キー単位のマージではない。未指定の列を古い取得結果で上書きしない。未知のトップレベル入力は検証で拒否されず、更新対象へ転記されない。

変更項目がなく `roleId` だけでも `updatedAt` は更新され、監査と変更イベントが発生する。`lastUsedAt` は更新しない。成功応答は **204・空本文**。保存済みロールを返さない。

DBには `name: varchar(256)`、`description: varchar(1024)`、`color: nullable varchar(256)`、`iconUrl: nullable varchar(512)`、`displayOrder: integer` などの制約がある。APIが通すことと保存成功は別。DBエラーを独自の新しい400エラーへ読み替えない。任意の壊れたポリシーを有効な型へ無断で正規化しない。

### 2.3 showの出力

200で以下を返す。閲覧者によるフィールドの出し分けはない。

`id`, `createdAt`, `updatedAt`, `name`, `description`, `color`, `iconUrl`, `target`, `condFormula`, `isPublic`, `isAdministrator`, `isModerator`, `isExplorable`, `asBadge`, `preserveAssignmentOnMoveAccount`, `canEditMembersByModerator`, `displayOrder`, `policies`, `usersCount`。

- `createdAt` は設定されたID方式でIDから復元した日時、`updatedAt` は保存日時。ISO 8601文字列。`lastUsedAt` は出力しない。
- `usersCount` はそのroleIdの有効な手動割り当て行数。`expiresAt IS NULL OR expiresAt > now`。条件一致ユーザー数を数えない。
- `policies` は保存objectのコピーへ、不足またはnullの既知キーを `{ useDefault: true, priority: 0, value: DEFAULT_POLICIES[key] }` として補う。インスタンスの基本ポリシーではなく、本家のコード既定値を表示する。補完によってDBは変更しない。未知の保存キーも残す。
- 読み取り時の取得・人数集計を先に済ませ、レスポンス変換はDBにアクセスしない。

### 2.4 エラーと優先順

応答は `{ error: { message, code, id, kind, ...任意のinfo } }`。message・id・kindも互換対象。全ケースのcode/idは[JSON](../compatibility/role/http-cases.json)に固定する。

| 状況 | HTTP / code | kind / 注意 |
| --- | --- | --- |
| トークンなし | 401 / CREDENTIAL_REQUIRED | client、`WWW-Authenticate: Bearer realm="Misskey"` |
| 不正トークン | 401 / AUTHENTICATION_FAILED | client、WWW-Authenticateのinvalid_token |
| サスペンド | 403 / YOUR_ACCOUNT_SUSPENDED | permission、rootでも拒否 |
| 資格なし | 403 / ROLE_PERMISSION_DENIED | permission、show/updateでmessageとidが異なる |
| scope不足 | 403 / PERMISSION_DENIED | permission、WWW-Authenticateのinsufficient_scope |
| 入力不備 | 400 / INVALID_PARAM | client、infoは最初のAjvエラーのschemaPathとmessage |
| 対象なし | 400 / NO_SUCH_ROLE | client、show/updateでidが異なる |
| 予期しない実行エラー | 500 / INTERNAL_ERROR | server、動的な内部エラー情報を完全一致の期待値にしない |

本家はclient種別にもWWW-Authenticateのinvalid_requestを付ける。資格なしとscope不足が同時なら資格なしを返す。GET405など、JSON errorを持たない応答もある。独自の共通エラー変換ですべてを同じJSONへ揃えない。

## 3. 適用ロール・条件式・資格

評価の入力は取得済みのロール定義、割り当て、ユーザー属性、インスタンス設定、基準時刻とする。

### 3.1 適用ロール

1. `expiresAt === null || expiresAt > at` の割り当てだけを使う。等しい時刻は失効。読み取りによって期限切れ行を削除しない。
2. 有効な割り当てのroleIdに一致するロールを取得する。
3. `target === conditional` の全ロールをユーザー属性と(2)のロールで評価し、一致したロールを加える。

`roleAssignedTo` は(2)だけを見る。条件付きロールの一致結果を別の条件へ連鎖適用しない。本家の(2)は `target === manual` で絞っていないため、既存の割り当てがある条件付きロールも含む。同じ条件付きロールが(2)と(3)で重複し得る。少なくとも実効ポリシー・資格の結果を変えず、移行時にその割り当てを勝手に削除しない。

### 3.2 条件式

| type | 本家の評価 |
| --- | --- |
| `and` / `or` / `not` | `values.every` / `values.some` / `!value`。空andはtrue、空orはfalse |
| `roleAssignedTo` | 上述の割り当てロールにroleIdがある |
| `isLocal` / `isRemote` | hostがnull / 非null |
| `isSuspended`, `isLocked`, `isBot`, `isCat`, `isExplorable` | 対応するユーザー属性 |
| `createdLessThan` | `createdAt > at - sec * 1000` |
| `createdMoreThan` | `createdAt < at - sec * 1000` |
| `followersLessThanOrEq` / `followersMoreThanOrEq` | followersCountがvalue以下 / 以上 |
| `followingLessThanOrEq` / `followingMoreThanOrEq` | followingCountがvalue以下 / 以上 |
| `notesLessThanOrEq` / `notesMoreThanOrEq` | notesCountがvalue以下 / 以上 |

作成時間条件の等号はどちらもfalse。コメントの日本語ではなくコードの比較式を基準にする。作成日時はID由来であり、Userへ架空のcreatedAt列を要求しない。

未知のtypeと評価中の例外は、その評価呼び出しでfalseになる。例えば壊れた子条件を `not` で囲むとtrueになり得る。本家APIは条件式の再帰構造を検証しない。初期実装で新たな入力制約を加える場合は、互換維持と混ぜず別途判断する。

### 3.3 資格

未認証は管理者・モデレーターともfalse。`rootUserId === user.id` は両方true。それ以外は適用ロール中の `isAdministrator` が管理者資格、`isModerator || isAdministrator` がモデレーター資格を与える。条件付きロールも対象。表示用の `isPublic`, `asBadge`, `isExplorable`, `displayOrder` は資格に影響しない。

root・管理者資格は実効ポリシー全項目を特別値にしない。HTTPのサスペンド拒否・scope検査はこの資格関数とは別。期限切れロールを含み得る一覧用 `getAdministratorIds` 等を、本人の資格判定へ流用しない。

## 4. ポリシーの集約

全既定値は[policy-defaults.json](../compatibility/role/policy-defaults.json)に固定する。基本値は `{ ...DEFAULT_POLICIES, ...meta.policies }`。

各キーを独立して評価する。ロールにキーがなければ `{ priority: 0, useDefault: true }` として扱う。priorityが2の候補があれば2だけ、なければ1があれば1だけ、それもなければ全候補を使う。単純な `Math.max(priority)` ではない。`useDefault` は選択後の候補値をそのキーの基本値へ置き換える。通常のoverrideが選択されている場合に、基本値を必ず候補へ加えることはしない。

| 値の種類 | 集約 |
| --- | --- |
| boolean全件（alwaysMarkNsfwも含む） | `value === true` の候補が一つでもあればtrue |
| number全件（rateLimitFactor・期間・件数も含む） | 最大値。小さい方が寛容そうという理由で変更しない |
| maxFileSizeMb | 候補の最大値と `floor(config.maxFileSize / 1024 / 1024)` の小さい方 |
| chatAvailability | availableがあればavailable、次にreadonly、それ以外unavailable |
| uploadableFileTypes | trimして空を除いた和集合。最初の出現順。パターンの包含関係で最適化しない |

匿名（userId=null）は基本値をそのまま返し、maxFileSizeの上限処理・配列のtrim等を通さない。ログイン済みで適用ロールがない場合は、基本値を集約へ通す。この違いも追加probeで確認する。

例: 基本容量55、priority=1の200とpriority=2/useDefaultの999なら55。priority=3の999とpriority=1の200なら200。同優先度の容量100/200は200。候補なしの既知キーは基本値を使う。

## 5. 所有範囲と公開契約

以下は業務側の契約。名称は実装時に整えてよいが、意味・参照条件・成立範囲を変えない。HTTP用Packed型、TypeORM Entity/EntityManager、Hono Context、DIコンテナは含めない。

### 5.1 受け渡す値

| 値 | 内容 |
| --- | --- |
| `Actor` | 認証済みの `userId` と `credentialGrant: { readRole: boolean, updateRole: boolean }`。grantは認証アダプタがnative tokenまたは実scopeから作る。クライアント入力を転記しない。資格とは別で、任意のisAdminフラグを認可根拠にしない |
| `UserRoleFacts` | userId、host、IDから復元したcreatedAtMs、isSuspended/isLocked/isBot/isCat/isExplorable、followersCount/followingCount/notesCount |
| `InstanceRoleFacts` | rootUserId: stringまたはnull、basePoliciesの保存object。アップロード上限bytesは必要な設定だけを別途注入 |
| `RoleDefinition` | id、更新可能な全項目、updatedAtMs、lastUsedAtMs。condFormula/policiesは保存JSONを保持できる値。業務上の正常値を判定する型と分ける |
| `RoleAssignment` | id、userId、roleId、expiresAtMs: numberまたはnull |
| `RolePatch` | §2.2の更新可能な項目だけ。省略と明示nullを区別し、roleId/id/日時は入力パッチに含めない |
| `RoleShowData` | RoleDefinition、IDから復元したcreatedAtMs、有効なassignedCount。HTTP側が取得済みの値から§2.3へ変換 |
| `RolePolicyInputs` | user: UserRoleFactsまたはnull、roles、assignments、basePolicies、uploadLimitBytes、atMs |

DBから取得した任意JSONを型アサーションだけで「検証済み条件式・ポリシー」にしない。保存値の互換性を保ち、純粋な評価処理がどこまで解釈できるかを明示する。業務モデルはEntity全体のコピーではなく、上記操作に必要な値に限る。

### 5.2 能力と依存方向

| 所有者 | 公開する操作と結果 |
| --- | --- |
| Role | `showRole(actor, roleId, evaluation) -> RoleShowData`。モデレーター資格をUseCaseで確認。対象なし・資格なしは業務例外 |
| Role | `updateRole(actor, roleId, patch, evaluation) -> void`。更新UseCaseが認可、排他取得、patch適用、保存、監査追記を所有 |
| Role | `getEffectivePolicies(userId|null, evaluation) -> RolePolicies`。材料取得Serviceが純粋な評価へ渡す。別UseCaseを呼ばない |
| Role | 純粋な `evaluateCondition`、`selectApplicableRoles`、`evaluatePolicies`、`evaluatePrivileges`。引数は材料とatMs、IOなし |
| ユーザー参照 | `readUserRoleFacts(userId) -> UserRoleFacts`。作成日時のID解釈もこのアダプタで済ませる。不存在は明示的な失敗 |
| 設定参照 | `readInstanceRoleFacts() -> InstanceRoleFacts`。設定全体やMeta Entityを公開しない |
| 監査 | `appendRoleUpdate({ actorId, roleId, before, after, occurredAtMs }) -> void`。呼び出し元のトランザクションに参加し、失敗は例外 |

ユーザー参照・設定参照・監査からRoleへ依存しない。Roleが認可の判定を所有する。一般のユーザー管理や設定管理の全機能は前提としない。Role以外のテーブルをRoleRepository経由で自由に更新する入口を作らない。

業務例外は少なくとも `ActorSuspended`、`ModeratorRequired`、`AdministratorRequired`、`CredentialScopeDenied`、`RoleNotFound` を区別する。UseCaseはHTTP型を投げず、HTTPアダプタが対象APIに対応する§2.4のstatus/code/id/message/kindへ変換する。サスペンド、資格、credentialGrant、対象の順序をUseCaseでも維持する。

### 5.3 更新トランザクションの窓口

既存の `TransactionRunner<Scope>.run(work)` を利用し、Role更新専用のScopeを組み立てる。

```ts
interface RoleUpdateScope {
  roles: {
    getForUpdate(roleId: string): Promise<RoleDefinition | null>;
    savePatch(roleId: string, patch: RolePatch, updatedAtMs: number): Promise<RoleDefinition>;
  };
  authorizationFacts: {
    read(actorId: string): Promise<{
      user: UserRoleFacts;
      instance: InstanceRoleFacts;
      roles: readonly RoleDefinition[];
      assignments: readonly RoleAssignment[];
    }>;
  };
  auditLogs: {
    appendRoleUpdate(record: RoleUpdateAudit): Promise<void>;
  };
}
```

これは全Repositoryのコンテナではなく、更新に必要な能力だけを同じ接続へ結び付けた束。`authorizationFacts.read` はキャッシュを使わないDB参照であり、判断結果を返す関数ではない。純粋な資格評価はRoleが行う。

認可には変更前の材料を使う。対象行の排他取得後に実際のbeforeを確定し、パッチ保存で返されたafterを同じトランザクションで監査へ渡す。更新対象が自分の資格に関係する場合も、新しい資格をその操作の許可に使わない。認可時点以後の他操作による資格剥奪まで厳密に直列化する保証は加えない。

保存・監査・commitの失敗を成功値に変換しない。トランザクション専用の窓口を終了後に使用しない。commit結果不明では自動再試行しない。正常完了後に自プロセスの材料と操作内メモを無効化し、他プロセスへの通知を試みる。通知失敗は確定済み更新の失敗へ変換しない。

### 5.4 評価境界とキャッシュの接続

`evaluation` は一つの業務判断で固定した `atMs` と、その境界に限ったメモを持つ。最初の評価時刻を使い、長時間処理の次の段階・再試行では新しい境界を作る。材料を自分で更新した場合は依存するメモを破棄し、同じatMsで再評価する。返した配列・ポリシーを呼び出し側で変えても他の評価へ影響させない。

初期の通知契約は `{ kind: 'role-definitions-changed', roleId }`。通知の値を正本として再投入せず、受信側がロール定義材料を無効化する。割り当て・ユーザー属性・設定の書き込みを後続に追加するときは、それぞれの材料と操作内メモの依存を無効化する契約をその機能へ接続する。

#119の設定項目は、材料ごとの有限の `ttlMs` と、ユーザー単位の材料キャッシュの有限の `maxEntries`。ロール定義は一つのスナップショットとして保持する。正の有限値として検証し、具体的な既定値は#119で選ぶ。期限はDB取得開始から数え、参照・古い読み取りの再投入で延長しない。取得中の無効化と購読再接続時の破棄も詳細設計§6.2を維持する。永続ジョブ・二段の値キャッシュは前提にしない。

## 6. 監査の形式・保持

本家の `moderation_log` は `id`, `userId`, `type`, `info` を持つ。`type='updateRole'`、`info={ roleId, before, after }`。before/afterはHTTPのRole出力ではなく保存行のスナップショットであり、lastUsedAtも含む。保存時に日時はJSONのISO文字列となる。idから監査のcreatedAtを復元する。新しいcreatedAt列や独自監査テーブルを初期実装で加えない。

監査モジュールが業務スナップショットから既存の保存形へ変換する。`policies` の表示用既定値補完や `usersCount` をスナップショットへ混ぜない。呼び出し側はORM Entityを渡さない。

本家のModerationLogService・参照箇所に期間による自動削除は見当たらない。永続保持を期限付きの観測ログへ置き換えない。ただしactorのUser FKは **ON DELETE CASCADE** なので、そのユーザーの物理削除時には監査も削除される。ロール削除そのものに対するFKはinfo内のroleIdにはない。この既存の保持挙動を監査の永久保持保証と誤記しない。

本家のupdateは保存・再取得・イベント発行の後、監査の完了を待たずに返る。追加HTTP probeは成功後に監査をpollして存在とスナップショットを確認する。「204の時点で必ず監査が保存済み」は本家の期待値にしない。

## 7. 意図的な差異の期待値

以下は既存のRole詳細設計で合意済みであり、本家との完全一致テストへ混ぜない。

| ケース | 新実装の期待値 | 後続 |
| --- | --- | --- |
| 監査保存失敗 | ロール更新もrollback。204にしない | #118 / #121 |
| 同一ロールの並行更新 | 直前の確定値をbeforeへ記録。異なる項目を失わない。同項目は後から成立した値 | #118 / #121 |
| キャッシュに古い資格 | 更新tx内DBの材料で拒否。今回の入力で得る資格で許可しない | #118 / #120 |
| commit結果不明 | 通常のrollback・成功と区別し、安全未確認の再実行なし | #118 / #121 |
| 通知失敗・commit後停止 | 更新と監査は残る。通知を逃したプロセスは有限TTL後の参照で回復 | #119 / #121 |
| 同一判断中の失効時刻越え | 固定atMsで揃える。次の判断境界は新しい時刻 | #117 |
| in-flightの無効化・購読再接続 | 古い取得結果を再登録しない。再接続時に対象材料を破棄 | #119 |
| null・未指定を除く非文字列の認証トークン | **400・空本文を返して完了する**。本家は `reply.code(400)` の後にsendせず、追加probeでは500msでクライアントを打ち切った。2026-10-17にユーザーが修正採用を承認 | #120 / #121 |

## 8. 実行結果と引き継ぎ

参照実装の追加HTTP probeは、実PostgreSQL・Redisと本家のHTTPサーバーを使用する。認証済みユーザーを固定するモックではない。初期状態は専用DBへ用意し、本家の通知形式で投入した材料のキャッシュへ反映する。

実行結果・コマンド・環境・再現手順は[README](../compatibility/role/README.md)を参照。追加unit probeのRepository等は固定材料の仮実装であり、純粋に評価式の結果を採取するもの。HTTP probeのDB・Redisの実行確認とは区別する。

コード読解のみの確認: 全フィールドのDB制約、異常なJSONの全パターン、actor削除のCASCADE、監査の定期削除処理が見当たらないこと。追加probeの通過をこれらすべての実行検証の代用にはしない。

次は #117。評価関数・操作内メモを本書§3–5とfixtureに沿って実装する。その後#118と#119、両者の接続後#120、総合検証#121の順。新旧双方に同じ入力を与えた比較は新Role実装が揃ってから行う。初回の本家側期待値は本資料へ固定し、通常CIで本家サーバーを毎回起動する必要はない。
