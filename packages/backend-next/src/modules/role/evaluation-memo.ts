/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class EvaluationInvalidated extends Error {
	readonly name = 'EvaluationInvalidated';
}

export class EvaluationClosed extends Error {
	readonly name = 'EvaluationClosed';
}

interface MemoEntry {
	dependencies: readonly string[];
	promise: Promise<unknown>;
}

export class EvaluationMemo {
	private readonly entries = new Map<string, MemoEntry>();
	private closed = false;

	async get<T>(key: string, dependencies: readonly string[], load: () => Promise<T>): Promise<T> {
		this.assertOpen();
		let entry = this.entries.get(key);
		if (!entry) {
			const created: MemoEntry = {
				dependencies: [...dependencies],
				promise: Promise.resolve().then(() => {
					this.assertCurrent(key, created);
					return load();
				}).then(value => {
					this.assertCurrent(key, created);
					return structuredClone(value);
				}).catch((error: unknown) => {
					this.assertCurrent(key, created);
					this.entries.delete(key);
					throw error;
				}),
			};
			this.entries.set(key, created);
			entry = created;
		}
		const value = await entry.promise;
		this.assertCurrent(key, entry);
		return structuredClone(value) as T;
	}

	invalidate(dependencies: readonly string[]): void {
		this.assertOpen();
		for (const [key, entry] of this.entries) {
			if (entry.dependencies.some(dependency => dependencies.includes(dependency))) {
				this.entries.delete(key);
			}
		}
	}

	close(): void {
		this.closed = true;
		this.entries.clear();
	}

	assertOpen(): void {
		if (this.closed) {
			throw new EvaluationClosed('The evaluation session has ended');
		}
	}

	private assertCurrent(key: string, entry: MemoEntry): void {
		this.assertOpen();
		// エントリの同一性を世代とする。削除後に完了した取得で新しいメモを消さない。
		if (this.entries.get(key) !== entry) {
			throw new EvaluationInvalidated('Evaluation inputs changed during the read');
		}
	}
}
