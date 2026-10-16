/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class ResourceScope {
	private readonly cleanups: (() => Promise<void>)[] = [];
	private closing?: Promise<void>;

	defer(cleanup: () => Promise<void>): void {
		if (this.closing) {
			throw new Error('Resource scope already closing');
		}
		this.cleanups.push(cleanup);
	}

	close(): Promise<void> {
		// 停止要求が重なっても二重解放しない。失敗時も同じ結果を返し、解放処理を再実行しない。
		this.closing ??= this.cleanup();
		return this.closing;
	}

	private async cleanup(): Promise<void> {
		const errors: unknown[] = [];
		for (const close of this.cleanups.reverse()) {
			try {
				await close();
			} catch (error) {
				// 最初の失敗で抜けると、残りの接続やサーバーが解放されず停止を妨げる。
				errors.push(error);
			}
		}

		if (errors.length) {
			throw new AggregateError(errors, 'Resource cleanup failed');
		}
	}
}
