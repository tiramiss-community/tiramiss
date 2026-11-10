/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createActorInstanceRegistration } from '../../../src/composition/actor-instance-registration.js';
import { createLogger } from '../../../src/platform/logger.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes; reject = no;
	});
	return { promise, resolve, reject };
}

test.each(['settings', 'register', 'increment'])('start returns immediately while %s remains pending and close drains its real effect', async stage => {
	const gate = deferred<void>();
	const entered = deferred<void>();
	const effects: string[] = [];
	const controller = createActorInstanceRegistration({
		enabled: async () => {
			effects.push('settings'); if (stage === 'settings') {
				entered.resolve(); await gate.promise;
			} return true;
		},
		fetchOrRegister: async host => {
			effects.push(`register:${host}`); if (stage === 'register') {
				entered.resolve(); await gate.promise;
			} return { id: 'instance' };
		},
		increment: async id => {
			if (stage === 'increment') {
				entered.resolve(); await gate.promise;
			} effects.push(`increment:${id}`);
		},
	}, createLogger('test', () => { }));
	expect(controller.start('origin.test')).toBeUndefined();
	await entered.promise;
	let drained = false;
	const close = controller.close().then(() => {
		drained = true;
	});
	await Promise.resolve();
	expect(drained).toBe(false);
	expect(effects).not.toContain('increment:instance');
	gate.resolve(); await close;
	expect(effects).toEqual(['settings', 'register:origin.test', 'increment:instance']);
});

test('disabled stats skip both instance registration and increment', async () => {
	const effects: string[] = [];
	const controller = createActorInstanceRegistration({
		enabled: async () => false, fetchOrRegister: async () => {
			effects.push('register'); return { id: 'i' };
		}, increment: async () => {
			effects.push('increment');
		}
	}, createLogger('test', () => { }));
	controller.start('remote.test'); await controller.idle(); expect(effects).toEqual([]);
});

test.each(['settings', 'register', 'increment'])('%s rejection is diagnosed and drained without retry or escaping start', async stage => {
	const logs: string[] = [];
	const effects: string[] = [];
	const fail = () => {
		throw Error('injected failure');
	};
	const controller = createActorInstanceRegistration({
		enabled: async () => {
			effects.push('settings'); if (stage === 'settings') {
				fail();
			} return true;
		},
		fetchOrRegister: async () => {
			effects.push('register'); if (stage === 'register') {
				fail();
			} return { id: 'instance' };
		},
		increment: async () => {
			effects.push('increment'); if (stage === 'increment') {
				fail();
			}
		},
	}, createLogger('test', line => logs.push(line)));
	controller.start('origin.test'); await controller.close();
	expect(logs).toHaveLength(1);
	expect(JSON.parse(logs[0])).toMatchObject({ event: 'actor-instance-registration.failed', host: 'origin.test', stage });
	expect(effects).toEqual(stage === 'settings' ? ['settings'] : stage === 'register' ? ['settings', 'register'] : ['settings', 'register', 'increment']);
});

test('synchronously throwing settings reader is also diagnosed without escaping start', async () => {
	const logs: string[] = [];
	const controller = createActorInstanceRegistration({
		enabled() {
			throw Error('sync');
		}, fetchOrRegister: async () => ({ id: 'i' }), increment: async () => { }
	}, createLogger('test', line => logs.push(line)));
	controller.start('origin.test'); await controller.close(); expect(logs).toHaveLength(1);
});
