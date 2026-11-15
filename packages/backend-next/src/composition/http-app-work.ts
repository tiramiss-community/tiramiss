/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Hono } from 'hono';
const work = new WeakMap<Hono, () => Promise<void>>();
export function registerHttpAppWork(app: Hono, idle: () => Promise<void>): void {
	work.set(app, idle);
}
/** Call after accepted HTTP handlers finish, so none can add later work. */
export async function drainHttpAppWork(app: Hono): Promise<void> {
	await work.get(app)?.();
}
