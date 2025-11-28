import { spawn } from "node:child_process";

/**
 * `run` ヘルパーが返す結果のオブジェクト。
 */
export interface RunResult {
  code: number; // 終了コード（0=成功）
  out: string; // 標準出力の蓄積
  err: string; // 標準エラーの蓄積
}

/**
 * 子プロセスを起動し、stdout/stderr を収集（必要に応じてライブ出力）します。
 * 終了コードが 0 以外でも例外は投げず、呼び出し側が `code` を判定します。
 *
 * @param cmd 実行ファイル名（例: 'git'）。
 * @param args 実行ファイルへ渡す引数の配列。
 * @param cwd 作業ディレクトリ（null の場合は親プロセスを継承）。
 * @param quiet true の場合、実行中のライブ出力を抑制します。
 * @returns RunResult { code, out, err } を解決する Promise。
 */
export function run(
  cmd: string,
  args: string[],
  cwd: string | null = null,
  quiet = false,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    console.log(`> ${cmd} ${args.join(" ")}`);

    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: cwd !== null ? cwd : undefined,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        const text: string = chunk.toString();
        stdoutBuffer += text;
        if (!quiet) {
          process.stdout.write(text);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        const text: string = chunk.toString();
        stderrBuffer += text;
        if (!quiet) {
          process.stderr.write(text);
        }
      });
    }

    child.on("error", (err: unknown) => {
      reject(err);
    });

    child.on("close", (code: number | null) => {
      resolve({ code: code ?? 0, out: stdoutBuffer, err: stderrBuffer });
    });
  });
}
