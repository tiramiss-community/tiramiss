import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ensureClean, git, gitOk, rev } from "./utils/git";
import { normalizeUpstreamTagNamespace } from "./utils/upstream-tags";

/**
 * Fork 元 upstream リポジトリのブランチ(デフォルト: upstream/develop)を
 * このリポジトリ内の同期用ブランチ(デフォルト: develop-upstream)へマージ反映するスクリプト。
 *
 * GitHub Actions ワークフロー断片をローカル/CI 双方で再利用できる形にしたもの。
 */

const argv = yargs(hideBin(process.argv))
  .usage("$0 [options]")
  .option("upstreamUrl", {
    type: "string",
    default:
      process.env.UPSTREAM_URL ?? "https://github.com/misskey-dev/misskey.git",
    describe: "Upstream repository URL (fork 元)",
  })
  .option("upstreamRemote", {
    type: "string",
    default: process.env.UPSTREAM_REMOTE ?? "upstream",
    describe: "Remote name to use for upstream",
  })
  .option("targetBranch", {
    type: "string",
    default: process.env.TARGET_BRANCH ?? "develop-upstream",
    describe: "Local/remote branch to update (同期先)",
  })
  .option("sourceRef", {
    type: "string",
    default: process.env.SOURCE_REF ?? "upstream/develop",
    describe: "Ref to merge from (同期元)",
  })
  .option("upstreamTagNamespace", {
    type: "string",
    default: process.env.UPSTREAM_TAG_NAMESPACE,
    describe:
      "Namespace under refs/ where upstream tags will be stored (例: refs/tags/upstream)",
  })
  .option("push", {
    type: "boolean",
    default: (process.env.PUSH ?? "true").toLowerCase() === "true",
    describe: "Whether to push changes to origin",
  })
  .help()
  .parseSync();

const UPSTREAM_URL = argv.upstreamUrl;
const UPSTREAM_REMOTE = argv.upstreamRemote;
const TARGET_BRANCH = argv.targetBranch;
const SOURCE_REF = argv.sourceRef;
const PUSH = argv.push;
const UPSTREAM_TAG_NAMESPACE = normalizeUpstreamTagNamespace(
  UPSTREAM_REMOTE,
  argv.upstreamTagNamespace,
);

async function ensureUpstreamRemote() {
  // 既に remote があるかを簡易チェック
  if (await gitOk(["remote", "get-url", UPSTREAM_REMOTE])) {
    // URL が異なる場合の上書きは行わない（手動調整とする）
    return;
  }
  console.log(`▶ add remote ${UPSTREAM_REMOTE} ${UPSTREAM_URL}`);
  await git(["remote", "add", UPSTREAM_REMOTE, UPSTREAM_URL]);
}

async function fetchUpstream() {
  console.log(`▶ fetch --prune --no-tags ${UPSTREAM_REMOTE}`);
  await git(["fetch", "--prune", "--no-tags", UPSTREAM_REMOTE]);

  console.log(
    `▶ fetch tags ${UPSTREAM_REMOTE} refs/tags/* -> ${UPSTREAM_TAG_NAMESPACE}/*`,
  );
  await git([
    "fetch",
    "--prune",
    "--no-tags",
    UPSTREAM_REMOTE,
    `refs/tags/*:${UPSTREAM_TAG_NAMESPACE}/*`,
  ]);
}

async function pushUpstreamTagsToOrigin() {
  if (!PUSH) {
    return;
  }
  const refs = await git(
    ["for-each-ref", "--format=%(refname)", UPSTREAM_TAG_NAMESPACE],
    true,
  );
  if (!refs) {
    console.log(
      `ℹ ${UPSTREAM_TAG_NAMESPACE}/* に同期すべきタグがないため push をスキップします`,
    );
    return;
  }
  console.log(
    `▶ push origin ${UPSTREAM_TAG_NAMESPACE}/* (mirror upstream tags namespace)`,
  );
  await git([
    "push",
    "--prune",
    "--force",
    "origin",
    `${UPSTREAM_TAG_NAMESPACE}/*:${UPSTREAM_TAG_NAMESPACE}/*`,
  ]);
}

async function ensureTargetBranch() {
  // origin/TARGET_BRANCH が存在するか
  const remoteExists = await gitOk([
    "show-ref",
    "--verify",
    `refs/remotes/origin/${TARGET_BRANCH}`,
  ]);
  if (remoteExists) {
    console.log(`▶ switch -C ${TARGET_BRANCH} origin/${TARGET_BRANCH}`);
    await git(["switch", "-C", TARGET_BRANCH, `origin/${TARGET_BRANCH}`]);
  } else {
    console.log(`▶ create ${TARGET_BRANCH} from ${SOURCE_REF}`);
    await git(["switch", "-C", TARGET_BRANCH, SOURCE_REF]);
    if (PUSH) {
      await git(["push", "-u", "origin", TARGET_BRANCH]);
    }
  }
}

async function mergeSource() {
  const before = await rev("HEAD");
  console.log(`BASE: ${TARGET_BRANCH} @ ${before}`);
  console.log(`▶ merge ${SOURCE_REF}`);
  try {
    await git(["merge", SOURCE_REF]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`✖ merge failed: ${detail}`);
    throw new Error("Merge conflict occurred. Please resolve manually.");
  }
  const after = await rev("HEAD");
  return before !== after;
}

(async () => {
  await ensureClean();

  await ensureUpstreamRemote();
  await fetchUpstream();
  await pushUpstreamTagsToOrigin();
  await ensureTargetBranch();
  const changed = await mergeSource();

  if (changed) {
    console.log("✔ merge introduced changes");
    if (PUSH) {
      console.log(`▶ push origin ${TARGET_BRANCH}`);
      await git(["push", "origin", TARGET_BRANCH]);
    }
  } else {
    console.log("ℹ no changes (already up to date)");
  }

  console.log("✔ sync done");
})().catch((e) => {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
