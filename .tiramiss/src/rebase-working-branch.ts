import * as fs from "node:fs";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { glob } from "glob";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  ensureClean,
  git,
  gitOk,
  localBranchExists,
  remoteBranchExists,
  rev,
} from "./utils/git";
import { run } from "./utils/proc";
import {
  buildUpstreamTagRef,
  normalizeUpstreamTagNamespace,
  sanitizeUpstreamTagSuffix,
} from "./utils/upstream-tags";

const argv = yargs(hideBin(process.argv))
  .usage("$0 [options]")
  .option("baseRef", {
    type: "string",
    default: process.env.BASE_REF ?? "origin/develop-upstream",
    describe: "Base reference used to reset working branch",
  })
  .option("baseUpstreamTag", {
    type: "string",
    default: process.env.BASE_UPSTREAM_TAG,
    describe:
      "develop-upstream 上のタグ名（例: 2025.10.0）。refs/tags/upstream/ は自動付与されます",
  })
  .option("upstreamTagNamespace", {
    type: "string",
    default: process.env.UPSTREAM_TAG_NAMESPACE,
    describe:
      "Namespace under refs/ where upstream tags are stored (例: refs/tags/upstream)",
  })
  .option("workingBranch", {
    type: "string",
    default: process.env.WORKING_BRANCH ?? "develop-working",
    describe: "Ephemeral integration prep branch name",
  })
  .option("toolRepo", {
    type: "string",
    default:
      process.env.TOOL_REPO ??
      "https://github.com/tiramiss-community/tiramiss-repository-ops.git",
    describe: "External repository URL to vendor (optional)",
  })
  .option("toolRef", {
    type: "string",
    default: process.env.TOOL_REF ?? "HEAD",
    describe: "Ref in tool-repo to checkout (branch|tag|commit)",
  })
  .option("toolDir", {
    type: "string",
    default: process.env.TOOL_DIR ?? "./",
    describe: "Target directory for vendored tool repo",
  })
  .option("push", {
    type: "boolean",
    default: (process.env.PUSH ?? "true").toLowerCase() === "true",
    describe: "Whether to push branches to origin",
  })
  .help()
  .parseSync(); // as unknown as CliArgs;

const BASE_REF = argv.baseRef;
const UPSTREAM_TAG_NAMESPACE = normalizeUpstreamTagNamespace(
  "upstream",
  argv.upstreamTagNamespace,
);
const BASE_UPSTREAM_TAG_SUFFIX =
  typeof argv.baseUpstreamTag === "string" && argv.baseUpstreamTag.trim()
    ? sanitizeUpstreamTagSuffix(argv.baseUpstreamTag)
    : undefined;
const BASE_UPSTREAM_TAG_REF = BASE_UPSTREAM_TAG_SUFFIX
  ? buildUpstreamTagRef(BASE_UPSTREAM_TAG_SUFFIX, UPSTREAM_TAG_NAMESPACE)
  : undefined;
const WORKING_BRANCH = argv.workingBranch;
const TOOL_REPO = argv.toolRepo;
const TOOL_REF = argv.toolRef;
const TOOL_DIR = argv.toolDir;
const PUSH = argv.push;

async function resolveBaseCommit() {
  const branchHead = await rev(BASE_REF);
  if (!BASE_UPSTREAM_TAG_REF) {
    return { label: BASE_REF, commit: branchHead };
  }

  const tagCommit = await rev(BASE_UPSTREAM_TAG_REF);
  if (!(await gitOk(["merge-base", "--is-ancestor", tagCommit, branchHead]))) {
    throw new Error(
      `指定したタグ ${BASE_UPSTREAM_TAG_SUFFIX} (${UPSTREAM_TAG_NAMESPACE}/${BASE_UPSTREAM_TAG_SUFFIX}) は ${BASE_REF} 上に存在しません。タグは develop-upstream の履歴上にある必要があります。`,
    );
  }

  return {
    label: `${BASE_REF} (tag ${BASE_UPSTREAM_TAG_REF})`,
    commit: tagCommit,
  };
}

async function fetchNamespacedUpstreamTagsFromOrigin() {
  if (!BASE_UPSTREAM_TAG_REF) {
    return;
  }
  console.log(`▶ fetch origin ${BASE_UPSTREAM_TAG_REF}`);
  try {
    await git([
      "fetch",
      "--no-tags",
      "origin",
      `${BASE_UPSTREAM_TAG_REF}:${BASE_UPSTREAM_TAG_REF}`,
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `origin から upstream タグ (${BASE_UPSTREAM_TAG_REF}) を取得できませんでした。sync-upstream を先に実行してタグを更新してください。\n${detail}`,
    );
  }
}

async function vendorToolRepo() {
  if (!TOOL_REPO) {
    console.log(`ℹ TOOL_REPO が未指定なのでスキップ（${TOOL_DIR} は触らない）`);
    return false;
  }

  const working = fs.mkdtempSync("/tmp/tiramiss-");

  try {
    console.log(`  • clone ${TOOL_REPO}@${TOOL_REF} -> ${working}`);
    // git clone --depth=1 --branch <TOOL_REF> が理想だが、コミット/タグ/ブランチに柔軟対応するためにクローン後 checkout
    const cloneResult = await run(
      "git",
      ["clone", "--depth=1", TOOL_REPO, working],
      null,
      true,
    );
    if (cloneResult.code !== 0) {
      throw new Error(`clone failed: ${cloneResult.err}`);
    }

    // checkout ref
    const fetchResult = await run(
      "git",
      ["-C", working, "fetch", "--depth=1", "origin", TOOL_REF],
      null,
      true,
    );

    if (fetchResult.code === 0) {
      await git(["-C", working, "checkout", "FETCH_HEAD"], true);
    } else {
      // ブランチ名で shallow clone できている可能性あり。失敗しても致命ではないので続行。
    }

    // ネストした .git を除去（ベンダリング）
    console.log("  • remove nested .git (vendoring)");
    rmSync(join(working, ".git"), { recursive: true, force: true });

    // -----------------------------------------------------------------------

    // 既存の target を一旦消す（ワークツリー汚染を避ける）
    const target = TOOL_DIR;
    if (existsSync(target)) {
      console.log(`  • remove existing ${join(target, "*")}`);
      rmSync(join(target, "*"), { recursive: true, force: true });
      await git(["add", "-A", target]);
    }

    for (const src of glob.sync(`${working}/**/*`)) {
      const dest = join(target, src.replace(working, ""));
      console.log("	• copy", src, "->", dest);
      cpSync(src, dest, { recursive: true });
    }

    console.log("	• install dependencies with pnpm");
    await run("pnpm", ["install", "--frozen-lockfile"], target);

    // 追加をステージ & コミット
    await git(["add", "-A", target]);
    if (!(await gitOk(["diff", "--cached", "--quiet"]))) {
      await git([
        "commit",
        "-m",
        `ops: vendor ${target} from ${TOOL_REPO}@${TOOL_REF}`,
      ]);
      return true;
    }

    console.log("  • no changes to commit for vendored tool repo");
    return false;
  } finally {
    rmSync(working, { recursive: true, force: true });
  }
}

(async () => {
  await ensureClean();

  console.log("▶ fetch --all --prune --no-tags");
  await git(["fetch", "--all", "--prune", "--no-tags"]);

  await fetchNamespacedUpstreamTagsFromOrigin();

  // WORKING_BRANCH を作成 / リセット
  const baseInfo = await resolveBaseCommit();
  console.log(`BASE: ${baseInfo.label} @ ${baseInfo.commit}`);
  if (await localBranchExists(WORKING_BRANCH)) {
    await git(["switch", WORKING_BRANCH]);
    await git(["reset", "--hard", baseInfo.commit]);
  } else {
    await git(["switch", "-C", WORKING_BRANCH, baseInfo.commit]);
  }

  // TOOL_DIR に別リポの内容をクローン（ベンダリング）
  console.log(`▶ vendor tool repo into ./${TOOL_DIR}`);
  const changed = await vendorToolRepo();

  // WORKING_BRANCH を push（変更があれば）
  if (PUSH && changed) {
    if (!(await remoteBranchExists(`origin/${WORKING_BRANCH}`))) {
      console.log("▶ push develop-working");
      await git(["push", "-u", "origin", WORKING_BRANCH]);
    } else if (changed) {
      // 作業ブランチが再構築されているはずなので強制プッシュが必要
      console.log("▶ force push develop-working");
      await git(["push", "--force", "origin", WORKING_BRANCH]);
    }
  }

  console.log("✔ pipeline done");
})().catch((e) => {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
