/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
/** 本家 NoteCreateService の5分集約と NoteDeleteService の即時減算。 */
export function createNoteInstanceCounts(ports: {
	enabled(): Promise<boolean>;
	fetchOrRegister(host: string): Promise<{
		id: string;
	}>;
	increment(id: string, amount: number): Promise<void>;
	decrement(id: string): Promise<void>;
	delayMs: number;
	onError(error: unknown, details: {
		instanceId: string;
		amount: number;
	}): void;
}) {
	const batches = new Map<string, {
		amount: number;
		timer: NodeJS.Timeout;
	}>();
	const pending = new Set<Promise<void>>();
	const perform = (instanceId: string, amount: number) => {
		const work = (async () => ports.increment(instanceId, amount))().catch(error => ports.onError(error, { instanceId, amount }));
		pending.add(work);
		void work.then(() => pending.delete(work));
	};
	return {
		async created(host: string | null): Promise<void> {
			if (host === null || !await ports.enabled()) {
				return;
			}
			const instance = await ports.fetchOrRegister(host);
			const batch = batches.get(instance.id);
			if (batch) {
				batch.amount++;
				return;
			}
			const timer = setTimeout(() => {
				const ready = batches.get(instance.id)!;
				batches.delete(instance.id);
				perform(instance.id, ready.amount);
			}, ports.delayMs);
			batches.set(instance.id, { amount: 1, timer });
		},
		async deleted(host: string | null): Promise<void> {
			if (host === null || !await ports.enabled()) {
				return;
			}
			const instance = await ports.fetchOrRegister(host);
			await ports.decrement(instance.id);
		},
		async close(): Promise<void> {
			const ready = [...batches];
			batches.clear();
			for (const [, batch] of ready) {
				clearTimeout(batch.timer);
			}
			for (const [id, batch] of ready) {
				perform(id, batch.amount);
			}
			// 発火済みタイマーの書き込みも含める。本家の performAllNow からの寿命管理上の差異。
			while (pending.size > 0) {
				await Promise.all([...pending]);
			}
		},
	};
}
