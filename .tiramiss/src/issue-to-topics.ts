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
  .option("bundlesOutput", {
    alias: "b",
    type: "string",
    default: process.env.BUNDLES_OUTPUT,
    describe:
      "If set, also write bundles.txt generated from issue bundle definitions",
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

type BundleDef = { name: string; topics: string[] };

type TopicItem =
  | { kind: "topic"; ref: string }
  | { kind: "pr"; number: number };

function isValidRefToken(s: string) {
  // ブランチ名トークンとして妥当な文字だけ許可する。
  // 注意: ブランチ名に "http" が含まれるケース（例: support-multiple-http-worker）があるため、
  // "http" という部分文字列で URL 判定して弾かない。
  return /^[A-Za-z0-9._/-]+$/.test(s);
}

function rawLineForError(raw: string) {
  return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
}

function parseBundleDef(rest: string, rawLine: string): BundleDef | null {
  const parts = rest
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    // bundle: <ref> は「直接 topics 指定」として扱う（bundles.txt は生成しない）
    return null;
  }

  const [name, ...topics] = parts;
  if (!isValidRefToken(name)) {
    throw new Error(
      `bundle 定義の形式が不正です: '${rawLine}'. bundle 名に使えない文字が含まれています。`,
    );
  }
  if (!name.startsWith("bundle/")) {
    throw new Error(
      `bundle 定義の形式が不正です: '${rawLine}'. bundle 名は 'bundle/...' を推奨します。`,
    );
  }

  const invalidTopic = topics.find((t) => !isValidRefToken(t));
  if (invalidTopic) {
    throw new Error(
      `bundle 定義の形式が不正です: '${rawLine}'. topic '${invalidTopic}' に使えない文字が含まれています。`,
    );
  }
  if (topics.includes(name)) {
    throw new Error(
      `bundle 定義の形式が不正です: '${rawLine}'. '${name}' が自分自身を topics に含んでいます。`,
    );
  }
  const uniqueTopics = Array.from(new Set(topics));
  if (uniqueTopics.length !== topics.length) {
    throw new Error(
      `bundle 定義の形式が不正です: '${rawLine}'. topics に重複があります。`,
    );
  }

  return { name, topics: uniqueTopics };
}

function parseTopicSpec(rest: string, rawLine: string): TopicItem {
  const trimmed = rest.trim();
  if (!trimmed) {
    throw new Error(
      `topic 指定の形式が不正です: '${rawLineForError(rawLine)}'. 例: 'topic: 123' / 'topic: bundle/feature-x'`,
    );
  }
  if (/\s/.test(trimmed)) {
    throw new Error(
      `topic 指定の形式が不正です: '${rawLineForError(rawLine)}'. topic は 1 トークンのみ指定してください。`,
    );
  }

  // PR number: 123 or #123
  const m = /^#?(\d+)$/.exec(trimmed);
  if (m) {
    return { kind: "pr", number: Number(m[1]) };
  }

  // Optional: allow PR URL inside topic:
  const url =
    /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)/.exec(
      trimmed,
    );
  if (url) {
    return { kind: "pr", number: Number(url[1]) };
  }

  if (!isValidRefToken(trimmed)) {
    throw new Error(
      `topic 指定の形式が不正です: '${rawLineForError(rawLine)}'. ブランチ名または PR 番号を指定してください。`,
    );
  }
  return { kind: "topic", ref: trimmed };
}

async function main() {
  const { token, repo, issue, output, bundlesOutput, labels } = argv;
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error("Invalid repo format: expected owner/name");
  }

  const octokit = token ? new Octokit({ auth: token }) : new Octokit();

  console.log(`📋 Fetching issue #${issue} from ${repo}...`);
  const { data: issueData } = await octokit.rest.issues.get({
    owner,
    repo: name,
    issue_number: issue,
  });

  const bodyText = issueData.body ?? "";

  // 箇条書き抽出
  // - 順序を維持する（Issue の箇条書き順 = topics.txt の順）
  // - 記法は topic:/bundle: のみ（旧来の裸ブランチ名 / #123 などは廃止）
  const items: TopicItem[] = [];
  const bundleDefs: BundleDef[] = [];
  const bundleDefByName = new Map<string, BundleDef>();
  const lines = bodyText.split(/\r?\n/);
  for (const line of lines) {
    const bulletMatch = line.match(/^\s*[-*]\s*(.*)$/);
    if (!bulletMatch) continue;

    const raw = bulletMatch[1].trim();
    if (!raw) continue;

    const prefix = raw.match(/^(bundle|topic)\s*:\s*(.+)$/i);
    if (!prefix) {
      continue;
    }

    const kind = prefix[1].toLowerCase();
    const rest = prefix[2].trim();

    if (kind === "topic") {
      items.push(parseTopicSpec(rest, raw));
      continue;
    }

    // bundle:
    // - bundle: bundle/x topic-a topic-b  -> bundles 定義
    // - bundle: bundle/x                 -> 直接 topics 指定
    const parts = rest
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const ref = parts[0];
    if (!ref || !isValidRefToken(ref)) {
      throw new Error(
        `bundle 指定の形式が不正です: '${rawLineForError(raw)}'. 例: 'bundle: bundle/feature-x topic-a topic-b'`,
      );
    }
    items.push({ kind: "topic", ref });

    const def = parseBundleDef(rest, raw);
    if (def) {
      const existing = bundleDefByName.get(def.name);
      if (existing) {
        const same =
          existing.topics.length === def.topics.length &&
          existing.topics.every((t, i) => t === def.topics[i]);
        if (!same) {
          throw new Error(
            `bundle 定義が重複しています: '${def.name}'. 異なる topics で複数回定義されています。`,
          );
        }
      } else {
        bundleDefByName.set(def.name, def);
        bundleDefs.push(def);
      }
    }
  }

  // 必要ラベル一覧（OR 条件）
  const requiredLabels = labels
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const prNumbers = new Set<number>();
  for (const item of items) {
    if (item.kind === "pr") {
      prNumbers.add(item.number);
    }
  }

  // PR → ブランチ名取得（必要ラベルフィルタ適用）
  const prToBranch = new Map<number, string | null>();
  if (prNumbers.size > 0) {
    if (!token) {
      throw new Error(
        "PR 番号を解決するには GitHub token が必要です。--token もしくは GITHUB_TOKEN を指定してください。",
      );
    }

    for (const num of prNumbers) {
      try {
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo: name,
          pull_number: num,
        });

        const prLabelNames = pr.labels
          .map((l) => (typeof l === "string" ? l : l.name))
          .filter((n): n is string => typeof n === "string" && n.length > 0);
        const hasRequired = requiredLabels.some((rl) =>
          prLabelNames.includes(rl),
        );
        if (!hasRequired) {
          console.log(
            `⏭ Skipping PR #${num} (labels: ${prLabelNames.join(",")}) - none of required: ${requiredLabels.join(",")}`,
          );
          prToBranch.set(num, null);
          continue;
        }

        prToBranch.set(num, pr.head.ref);
      } catch (e) {
        console.error(
          `⚠ Failed to fetch PR #${num}: ${e instanceof Error ? e.message : String(e)}`,
        );
        throw e;
      }
    }
  }

  // 解決 + 順序維持 + 重複排除（最初に出てきたものを採用）
  const topics: string[] = [];
  const seen = new Set<string>();
  let resolvedPrTopics = 0;
  for (const item of items) {
    const refRaw =
      item.kind === "topic" ? item.ref : (prToBranch.get(item.number) ?? null);
    if (!refRaw) continue;
    const ref = refRaw.trim();
    if (!ref) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    topics.push(ref);
    if (item.kind === "pr") {
      resolvedPrTopics += 1;
    }
  }

  // 出力
  const header = [
    "# Auto-generated from GitHub Issue",
    `# repo: ${repo}`,
    `# issue: #${issue}`,
    `# required labels (any): ${requiredLabels.join(", ")}`,
    `# topics: ${topics.length}`,
    `# resolved PR topics: ${resolvedPrTopics}`,
    "",
  ].join("\n");

  writeFileSync(output, `${header}${topics.join("\n")}\n`, "utf8");

  console.log(`✅ ${topics.length} entries written to ${output}`);

  if (bundlesOutput) {
    const bundlesHeader = [
      "# Auto-generated from GitHub Issue",
      `# repo: ${repo}`,
      `# issue: #${issue}`,
      `# bundle definitions: ${bundleDefs.length}`,
      "# format: <bundle-branch> <topic1> <topic2> ...",
      "",
    ].join("\n");

    const body = bundleDefs
      .map((b) => `${b.name} ${b.topics.join(" ")}`)
      .join("\n");
    writeFileSync(
      bundlesOutput,
      `${bundlesHeader}${body ? `${body}\n` : ""}`,
      "utf8",
    );
    console.log(
      `✅ ${bundleDefs.length} bundle definitions written to ${bundlesOutput}`,
    );
  }
}

main().catch((err) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
