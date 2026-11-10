/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Logger } from '../platform/logger.js';

export function createActorInstanceRegistration(ports: {
	enabled(): Promise<boolean>;
	fetchOrRegister(host: string): Promise<{ id: string }>;
	increment(id: string): Promise<void>;
}, logger: Logger) {
	const pending = new Set<Promise<void>>();

	async function run(host: string): Promise<void> {
		let stage = 'settings';
		try {
			// Unlike source's synchronous Meta snapshot, this read is a real async failure/timing boundary.
			if (!await ports.enabled()) {
				return;
			}
			stage = 'register';
			const instance = await ports.fetchOrRegister(host);
			stage = 'increment';
			await ports.increment(instance.id);
		} catch (error) {
			logger.error('actor-instance-registration.failed', { host, stage, error });
		}
	}

	async function idle(): Promise<void> {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	}

	return {
		start(host: string): void {
			const work = run(host);
			pending.add(work);
			void work.then(() => pending.delete(work));
		},
		idle,
		close: idle,
	};
}
