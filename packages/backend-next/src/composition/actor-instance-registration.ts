/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { InstanceMetadataTarget } from '../modules/federation/public.js';
import type { Logger } from '../platform/logger.js';

export function createActorInstanceRegistration(ports: {
	enabled(): Promise<boolean>;
	fetchOrRegister(host: string): Promise<InstanceMetadataTarget>;
	increment(id: string): Promise<void>;
	fetchMetadata(instance: InstanceMetadataTarget): Promise<void>;
}, logger: Logger) {
	const pending = new Set<Promise<void>>();

	function track(host: string, stage: string, work: () => Promise<void>): void {
		const running = (async () => work())().catch(error => {
			logger.error('actor-instance-registration.failed', { host, stage, error });
		});
		pending.add(running);
		void running.then(() => pending.delete(running));
	}

	async function run(host: string): Promise<void> {
		let stage = 'settings';
		try {
			// Unlike source's synchronous Meta snapshot, this read is a real async failure/timing boundary.
			if (!await ports.enabled()) {
				return;
			}
			stage = 'register';
			const instance = await ports.fetchOrRegister(host);
			track(host, 'increment', () => ports.increment(instance.id));
			track(host, 'metadata', () => ports.fetchMetadata(instance));
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
