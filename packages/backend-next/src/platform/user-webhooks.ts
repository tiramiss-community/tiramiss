/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Redis } from 'ioredis';
import { MiWebhook } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';
import type { RedisConfig } from '../config/types.js';
import type { UserWebhookEvent, UserWebhookTarget } from './job-queue/user-webhook.js';

type Hook = UserWebhookTarget & { active: boolean; on: string[] };

/** 本家 UserWebhookService の遅延取得キャッシュと internal イベント。 */
export async function openUserWebhooks(options: {
	manager: EntityManager; redis: RedisConfig; url: string; timeoutMs: number;
	enqueue(hook: UserWebhookTarget, type: UserWebhookEvent, note: Record<string, unknown>): Promise<void>;
	registerCleanup?(cleanup: () => Promise<void>): void;
}) {
	const subscriber = new Redis({ ...options.redis, connectTimeout: options.timeoutMs, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
	let hooks: Hook[] = [];
	let fetched = false;
	subscriber.on('error', () => { /* Redis の再接続は ioredis が行う。 */ });
	subscriber.on('message', (_channel, data) => {
		let event: { channel?: string; message?: { type?: string; body?: Hook } };
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		const body = event.message?.body;
		if (event.channel !== 'internal' || !body) {
			return;
		}
		switch (event.message?.type) {
			case 'webhookCreated':
				if (body.active) {
					hooks.push(body);
				}
				break;
			case 'webhookUpdated': {
				const index = hooks.findIndex(hook => hook.id === body.id);
				if (!body.active) {
					hooks = hooks.filter(hook => hook.id !== body.id);
				} else if (index < 0) {
					hooks.push(body);
				} else {
					hooks[index] = body;
				}
				break;
			}
			case 'webhookDeleted': hooks = hooks.filter(hook => hook.id !== body.id); break;
		}
	});
	const close = async () => {
		subscriber.disconnect();
	};
	options.registerCleanup?.(close);
	try {
		await subscriber.connect();
		await subscriber.subscribe(new URL(options.url).host);
	} catch (error) {
		subscriber.disconnect(); throw error;
	}
	return {
		async enqueue(userId: string, type: UserWebhookEvent, note: Record<string, unknown>) {
			if (!fetched) {
				hooks = await options.manager.getRepository(MiWebhook).findBy({ active: true });
				fetched = true;
			}
			await Promise.all(hooks.filter(hook => hook.userId === userId && hook.on.includes(type)).map(hook => options.enqueue(hook, type, note)));
		},
		close,
	};
}
