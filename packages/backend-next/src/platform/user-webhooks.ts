/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { openInternalEvents } from './internal-events.js';
import type { InternalEvents } from './internal-events.js';
import { MiWebhook } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { RedisConfig } from '../config/types.js';
import type { UserWebhookEvent, UserWebhookTarget } from './job-queue/user-webhook.js';

type Hook = UserWebhookTarget & { active: boolean; on: string[] };

/** 本家 UserWebhookService の遅延取得キャッシュと internal イベント。 */
export async function openUserWebhooks(options: {
	events?: InternalEvents;
	manager: EntityManager; redis: RedisConfig; url: string; timeoutMs: number;
	enqueue(hook: UserWebhookTarget, type: UserWebhookEvent, note: Record<string, unknown>): Promise<void>;
	registerCleanup?(cleanup: () => Promise<void>): void;
}) {
	let closed = false;
	let hooks: Hook[] = [];
	let fetched = false;
	let generation = 0;
	let connectedOnce = false;
	let closeTransport: (() => Promise<void>) | undefined;
	let unregister = () => {};
	let closing: Promise<void> | undefined;
	const close = () => {
		closed = true;
		generation++;
		unregister();
		hooks = [];
		fetched = false;
		closing ??= options.events ? Promise.resolve() : closeTransport?.() ?? Promise.resolve();
		return closing;
	};
	options.registerCleanup?.(close);
	const receiver = options.events ?? await openInternalEvents({ subscriberConfig: options.redis, url: options.url, timeoutMs: options.timeoutMs, onError: () => {}, registerCleanup: close => {
		closeTransport = close;
	} });
	if (!closed) {
		unregister = receiver.register({ onReady: () => {
			if (connectedOnce) {
				// 切断中の設定通知は再配信されないため、次の投稿では正本から読み直す。
				generation++;
				hooks = [];
				fetched = false;
			}
			connectedOnce = true;
		}, onInternal: event => {
			const { body } = event;
			if (typeof body.id !== 'string') {
				return;
			}
			if (event.type !== 'webhookDeleted' && (typeof body.active !== 'boolean'
			|| typeof body.userId !== 'string' || typeof body.url !== 'string' || typeof body.secret !== 'string'
			|| !Array.isArray(body.on) || !body.on.every(value => typeof value === 'string'))) {
				return;
			}
			const hook = body as unknown as Hook;
			switch (event.type) {
				case 'webhookCreated':
					if (hook.active) {
						generation++;
						hooks.push(hook);
					}
					break;
				case 'webhookUpdated': {
					generation++;
					const index = hooks.findIndex(hook => hook.id === body.id);
					if (!hook.active) {
						hooks = hooks.filter(hook => hook.id !== body.id);
					} else if (index < 0) {
						hooks.push(hook);
					} else {
						hooks[index] = hook;
					}
					break;
				}
				case 'webhookDeleted':
					generation++;
					hooks = hooks.filter(hook => hook.id !== body.id);
					break;
			}
		} });
	}

	return {
		async enqueue(userId: string, type: UserWebhookEvent, note: Record<string, unknown>) {
			if (closed) {
				throw new Error('User webhook cache is closed');
			}
			while (!fetched) {
				const readGeneration = generation;
				const active = await options.manager.getRepository(MiWebhook).findBy({ active: true });
				if (closed) {
					throw new Error('User webhook cache is closed');
				}
				if (readGeneration !== generation) {
					continue;
				}
				hooks = active;
				fetched = true;
			}
			await Promise.all(hooks.filter(hook => hook.userId === userId && hook.on.includes(type)).map(hook => options.enqueue(hook, type, note)));
		},
		close,
	};
}
