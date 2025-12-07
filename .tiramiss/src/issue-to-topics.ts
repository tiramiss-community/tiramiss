import { writeFileSync } from "node:fs";
import { Octokit } from "octokit";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .option("token", {
    alias: "t",
    type: "string",
    describe: "GitHub personal access token or GITHUB_TOKEN",
  })
  .option("repo", {
    alias: "r",
    type: "string",
    describe: "Target repository (owner/name)",
    default: "tiramiss-community/tiramiss",
  })
  .option("issue", {
    alias: "i",
    type: "number",
    describe: "Issue number to read",
    default: 47,
  })
  .option("output", {
    alias: "o",
    type: "string",
    default: "topics.txt",
    describe: "Output file path",
  })
  .option("labels", {
    alias: "L",
    type: "string",
    describe:
      "Comma-separated label names; PR must have at least one to be included",
    default: "先行実装,独自機能",
  })
  .help()
  .parseSync();

async function main() {
  const { token, repo, issue, output, labels } = argv;
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error("Invalid repo format: expected owner/name");
  }

  const octokit = new Octokit({ auth: token });

  console.log(`📋 Fetching issue #${issue} from ${repo}...`);
  const { data: issueData } = await octokit.rest.issues.get({
    owner,
    repo: name,
    issue_number: issue,
  });

  let bodyText = issueData.body ?? "";

  // 箇条書き抽出 + PR番号収集（1行につき最初の1つのみ。#123 または PR URL を認識）
  const prNumbers = new Set<number>();
  const lines = bodyText.split(/\r?\n/);
  for (const line of lines) {
    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (!bulletMatch) continue;

    const raw = bulletMatch[1].trim();

    // #123 と PR URL の両方を検出し、行内で早く現れた方を採用
    const urlRe =
      /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)/;
    const hashRe = /#(\d+)/;

    const urlMatch = urlRe.exec(raw);
    const hashMatch = hashRe.exec(raw);

    let chosen: number | null = null;
    if (urlMatch && hashMatch) {
      chosen =
        urlMatch.index < hashMatch.index
          ? Number(urlMatch[1])
          : Number(hashMatch[1]);
    } else if (urlMatch) {
      chosen = Number(urlMatch[1]);
    } else if (hashMatch) {
      chosen = Number(hashMatch[1]);
    }

    if (chosen != null && Number.isFinite(chosen)) {
      prNumbers.add(chosen);
    }
  }

  // 必要ラベル一覧（OR 条件）
  const requiredLabels = labels
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // PR → ブランチ名取得（必要ラベルフィルタ適用）
  const resolvedBranches: string[] = [];
  for (const num of prNumbers) {
    try {
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo: name,
        pull_number: num,
      });

      const prLabelNames = pr.labels.map((l: any) => l.name).filter(Boolean);
      const hasRequired = requiredLabels.some((rl) =>
        prLabelNames.includes(rl),
      );
      if (!hasRequired) {
        console.log(
          `⏭ Skipping PR #${num} (labels: ${prLabelNames.join(
            ",",
          )}) - none of required: ${requiredLabels.join(",")}`,
        );
        continue;
      }

      resolvedBranches.push(pr.head.ref);
    } catch (e) {
      console.error(
        `⚠ Failed to fetch PR #${num}: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }

  // 結合 & 重複排除
  const topics = Array.from(
    new Set([...resolvedBranches].map((s) => s.trim()).filter(Boolean)),
  );

  // 出力
  const header = [
    "# Auto-generated from GitHub Issue",
    `# repo: ${repo}`,
    `# issue: #${issue}`,
    `# required labels (any): ${requiredLabels.join(", ")}`,
    "",
  ].join("\n");

  writeFileSync(output, `${header}${topics.join("\n")}\n`, "utf8");

  console.log(`✅ ${topics.length} entries written to ${output}`);
}

main().catch((err) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
