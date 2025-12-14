import { run } from "./proc";

/**
 * git コマンドを実行し、標準出力(前後の空白を除去)を返します。
 * 終了コードが 0 以外の場合は Error を投げます。
 *
 * @param args 先頭の `git` を除いた Git の引数配列。
 * @param quiet 実行中の標準出力/標準エラーのライブ出力を抑制するかどうか。
 * @returns git プロセスの標準出力（trim 済み）。
 */
export async function git(args: string[], quiet = false) {
  const result = await run("git", args, null, quiet);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.err}`);
  }
  return result.out.trim();
}

/**
 * git コマンドが成功するか(終了コード 0 か)を確認します。
 * 例外は投げず、真偽値を返します。
 *
 * @param args Git の引数配列。
 * @returns 成功した場合は true、失敗した場合は false。
 */
export async function gitOk(args: string[]) {
  const result = await run("git", args, null, true);
  return result.code === 0;
}

/**
 * 作業ツリーがクリーン(未ステージ・未コミットの変更なし)であることを確認します。
 * `git status --porcelain` に出力がある場合は例外を投げます。
 */
export async function ensureClean() {
  const porcelain = await git(["status", "--porcelain"], true);
  if (porcelain.trim()) {
    throw new Error(
      "作業ツリーがクリーンではありません。コミット or stash してください。",
    );
  }
}

/**
 * 指定した ref(ブランチ/タグ/コミット)をコミットハッシュに解決します。
 *
 * @param ref 例: HEAD, main, タグ名など。
 * @returns コミット SHA 文字列。
 */
export async function rev(ref: string) {
  return git(["rev-parse", "--verify", `${ref}^{commit}`], true);
}

/**
 * ローカルブランチが存在するか確認します。
 *
 * @param branchName ブランチ名（refs/heads/ の接頭辞なし）。
 * @returns ローカルにブランチが存在する場合は true。
 */
export async function localBranchExists(branchName: string) {
  return gitOk(["show-ref", "--verify", `refs/heads/${branchName}`]);
}

/**
 * リモート追跡ブランチが存在するか確認します。
 *
 * @param branchName ブランチ名（refs/remotes/ の接頭辞なし）。
 * @returns リモート追跡ブランチが存在する場合は true。
 */
export async function remoteBranchExists(branchName: string) {
  return gitOk(["show-ref", "--verify", `refs/remotes/${branchName}`]);
}

/**
 * 2 つの ref のマージベースとなるコミットを取得します。
 *
 * @param a 1 つ目の ref。
 * @param b 2 つ目の ref。
 * @returns マージベースのコミット SHA。
 */
export async function mergeBase(a: string, b: string) {
  return git(["merge-base", a, b], true);
}

/**
 * base(除外)から head(含む)までの先祖パス上のコミットを、古い順で列挙します。
 *
 * @param base 基準となる ref(範囲の開始・除外)。
 * @param head 先頭となる ref(範囲の終端・含む)。
 * @returns 古い順(最古 -> 最新)のコミット SHA 配列。
 */
export async function listCommits(base: string, head: string) {
  const output = await git(
    ["rev-list", "--reverse", "--ancestry-path", `${base}..${head}`],
    true,
  );
  return output ? output.split("\n").filter(Boolean) : [];
}
