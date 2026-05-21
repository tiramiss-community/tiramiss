import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ensureClean, git, gitOk, remoteBranchExists, rev } from "./utils/git";

const argv = yargs(hideBin(process.argv))
  .usage("$0 [options]")
  .option("baseRef", {
    type: "string",
    default: process.env.BASE_REF ?? "develop-working",
    describe:
      "Bundles are rebuilt from this base ref (recommended: HEAD when running on develop-working)",
  })
  .option("toolDir", {
    type: "string",
    default: process.env.TOOL_DIR ?? "./",
    describe:
      "Directory used to search for bundles file (default: ./). Used mainly when vendored under .tiramiss",
  })
  .option("bundles", {
    type: "string",
    default: process.env.BUNDLES_FILE,
    describe:
      "Explicit bundles file path (overrides auto search). Format: '<bundle> <topic1> <topic2> ...' per line",
  })
  .option("push", {
    type: "boolean",
    default: (process.env.PUSH ?? "true").toLowerCase() === "true",
    describe: "Whether to push bundle branches to origin",
  })
  .help()
  .parseSync();

const BASE_REF = argv.baseRef;
const TOOL_DIR = argv.toolDir;
const PUSH = argv.push;
const BUNDLES_CANDIDATES = argv.bundles
  ? [argv.bundles]
  : [join(TOOL_DIR, "bundles.txt"), "bundles.txt"];

type Bundle = { name: string; topics: string[] };

function shouldKeepOursOnMergeConflict(path: string) {
  // bundle ブランチは「機能差分」を載せるのが目的。
  // .tiramiss や workflow は生成/運用用のため、bundle の merge で衝突した場合は ours を優先してノイズを減らす。
  return (
    path === ".tiramiss" ||
    path.startsWith(".tiramiss/") ||
    path === ".github/workflows" ||
    path.startsWith(".github/workflows/")
  );
}

async function isMergeInProgress() {
  // merge 中のみ存在する擬似 ref を見る（作業ディレクトリに依存しない）
  return gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
}

async function listUnmergedFiles() {
  const out = await git(["diff", "--name-only", "--diff-filter=U"], true);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function tryAutoResolveMergeConflictKeepingOurs() {
  if (!(await isMergeInProgress())) {
    return { resolved: false, remaining: [] as string[] };
  }

  const unmerged = await listUnmergedFiles();
  if (unmerged.length === 0) {
    return { resolved: false, remaining: [] as string[] };
  }

  const keepOurs = unmerged.filter(shouldKeepOursOnMergeConflict);
  if (keepOurs.length === 0) {
    return { resolved: false, remaining: unmerged };
  }

  console.log(
    `    - 衝突を自動解決: 生成物/運用ファイルは ours を採用 (${keepOurs.length} 件)`,
  );

  // 競合中ファイルのみを対象に ours を採用する（ディレクトリ指定は環境によって失敗しうるため）
  // さらに、git 実行ディレクトリがリポジトリ直下でない場合（例: .tiramiss）でも確実に解決できるよう
  // pathspec を `:(top)` でルート基準に固定する。
  const rooted = keepOurs.map((p) => `:(top)${p.replace(/^\.\//, "")}`);
  await git(["checkout", "--ours", "--", ...rooted], true);
  await git(["add", "--", ...rooted], true);

  const remaining = await listUnmergedFiles();
  if (remaining.length > 0) {
    return { resolved: false, remaining };
  }

  // CI では EDITOR が未設定で `git merge --continue` がエディタ起動に失敗することがある。
  // MERGE_MSG をそのまま使って非対話で確定させる。
  await git(["commit", "--no-edit"]);
  return { resolved: true, remaining: [] as string[] };
}

function bundlesTemplate() {
  return [
    "# bundles.txt",
    "# 1行=1バンドル。形式: <bundle-branch> <topic1> <topic2> ...",
    "#",
    "# 例:",
    "# bundle/feature-x topic-a topic-b",
    "",
  ].join("\n");
}

function initBundlesFileIfMissing() {
  const existing = BUNDLES_CANDIDATES.find((p) => existsSync(p));
  if (existing) {
    return { path: existing, created: false };
  }

  const isCi = (process.env.CI ?? "").toLowerCase() === "true";
  if (isCi) {
    return { path: null, created: false };
  }

  const target = BUNDLES_CANDIDATES[0];
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bundlesTemplate(), "utf8");
  return { path: target, created: true };
}

async function currentBranch(): Promise<string | null> {
  try {
    const name = await git(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      true,
    );
    return name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

function readBundles(): { path: string | null; bundles: Bundle[] } {
  for (const p of BUNDLES_CANDIDATES) {
    if (!existsSync(p)) continue;

    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    const bundles: Bundle[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        throw new Error(
          `bundles.txt の形式が不正です: '${rawLine}'. 例: 'bundle-xyz topicA topicB'`,
        );
      }

      const [name, ...topics] = parts;

      // ありがちなミス防止
      if (topics.includes(name)) {
        throw new Error(
          `bundles.txt の定義が不正です: '${name}' が自分自身を topics に含んでいます。`,
        );
      }
      const uniqueTopics = Array.from(new Set(topics));
      if (uniqueTopics.length !== topics.length) {
        throw new Error(
          `bundles.txt の定義が不正です: '${name}' の topics に重複があります。`,
        );
      }

      bundles.push({ name, topics: uniqueTopics });
    }

    return { path: p, bundles };
  }

  return { path: null, bundles: [] };
}

async function resolveRef(topic: string) {
  if (await gitOk(["rev-parse", "--verify", `${topic}^{commit}`])) {
    return topic;
  }
  for (const cand of [`origin/${topic}`, `upstream/${topic}`]) {
    if (await gitOk(["rev-parse", "--verify", `${cand}^{commit}`])) {
      return cand;
    }
  }
  throw new Error(`見つからないブランチ: ${topic}`);
}

async function rebuildBundle(bundle: Bundle, baseCommit: string) {
  console.log(
    `▶ rebuild bundle ${bundle.name} from ${BASE_REF} @ ${baseCommit}`,
  );
  await git(["switch", "-C", bundle.name, baseCommit]);

  for (const raw of bundle.topics) {
    const topic = await resolveRef(raw);
    console.log(`  • merge ${topic}`);

    if (await gitOk(["merge-base", "--is-ancestor", topic, "HEAD"])) {
      console.log(`    - skip (already included): ${topic}`);
      continue;
    }

    try {
      await git(["merge", "--no-ff", "--no-edit", topic]);
    } catch {
      const auto = await tryAutoResolveMergeConflictKeepingOurs();
      if (auto.resolved) {
        console.log("    - merge コンフリクトを自動解決（ours 優先）");
        continue;
      }

      const remaining = auto.remaining.length
        ? `\n未解決の衝突: ${auto.remaining.join(", ")}`
        : "";

      throw new Error(
        `merge コンフリクト: ${bundle.name} <- ${topic}. 解決後に 'git add -A && git merge --continue' を実行し、再実行してください。` +
          remaining,
      );
    }
  }

  if (!PUSH) {
    return;
  }

  if (!(await remoteBranchExists(`origin/${bundle.name}`))) {
    console.log(`▶ push -u origin ${bundle.name}`);
    await git(["push", "-u", "origin", bundle.name]);
  } else {
    console.log(`▶ force push origin ${bundle.name}`);
    await git(["push", "--force", "origin", bundle.name]);
  }
}

(async () => {
  await ensureClean();

  const startBranch = await currentBranch();
  const startCommit = await rev("HEAD");

  const init = initBundlesFileIfMissing();
  if (init.created) {
    console.log(
      `ℹ bundles.txt が見つからないため雛形を作成しました: ${init.path}`,
    );
    console.log(
      "ℹ bundles.txt を編集してから、再度 bundle-topics を実行してください。",
    );
    return;
  }

  if (!init.path) {
    throw new Error(
      "bundles.txt が見つかりません。CI では bundles.txt を事前に生成（例: issue-to-topics --bundlesOutput）してから実行してください。",
    );
  }

  const { path: bundlesPath, bundles } = readBundles();
  if (!bundlesPath) {
    throw new Error("bundles.txt が見つかりません（雛形作成にも失敗しました）");
  }

  console.log(`▶ fetch --all --prune --no-tags`);
  await git(["fetch", "--all", "--prune", "--no-tags"]);

  const baseCommit = await rev(BASE_REF);
  console.log(`BASE: ${BASE_REF} @ ${baseCommit}`);

  console.log(`▶ build bundles from ${bundlesPath}: ${bundles.length} entries`);
  for (const b of bundles) {
    await rebuildBundle(b, baseCommit);
  }

  // 成功時のみ元のブランチへ戻す（コンフリクト時は解決のためそのまま）
  if (startBranch) {
    console.log(`▶ switch back to ${startBranch}`);
    await git(["switch", startBranch]);
  } else {
    console.log(`▶ switch back to detached @ ${startCommit}`);
    await git(["switch", "--detach", startCommit]);
  }

  console.log("✔ bundles done");
})().catch((e) => {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
