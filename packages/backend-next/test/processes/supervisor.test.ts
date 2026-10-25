/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { configuration, freePort, launch } from '../helpers/process.js';
import { migrateTestDatabase as migrateDatabase } from '../helpers/database.js';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	database = await createTestDatabase();
	await migrateDatabase(database.config.database);
});
afterAll(async () => {
	await database?.close();
});
test.each(['normal', 'http', 'worker'])('supervises a real process tree through %s termination', async (mode) => {
	const config = await configuration({
		...database.config,
		http: { port: await freePort() },
		processes: { ...database.config.processes, workerCount: 2 },
	});
	const supervisor = launch('built/entrypoints/supervisor.js', config.path);
	let children: { role: string; pid: number }[] = [];
	try {
		await supervisor.ready;
		children = (supervisor.messages.find((m: any) => m.role === 'supervisor') as { children: typeof children })
			.children;
		expect(children.map((c) => c.role)).toEqual(['http', 'worker', 'worker']);
		if (mode === 'normal') {
			supervisor.child.kill('SIGTERM');
		} else {
			process.kill(children.find((c) => c.role === mode)!.pid, 'SIGKILL');
		}
		expect((await supervisor.exit).code).toBe(mode === 'normal' ? 0 : 1);
		for (const child of children) {
			expect(() => process.kill(child.pid, 0)).toThrow();
		}
	} finally {
		await supervisor.close();
		for (const child of children) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {}
		}
		await config.close();
	}
});

test.each(['startup-stall', 'shutdown-stall'])('bounds real child process %s', async (mode) => {
	const config = await configuration({
		...database.config,
		http: { port: await freePort() },
		processes: { workerCount: 1, startupTimeoutMs: 500, shutdownTimeoutMs: 100 },
	});
	const supervisor = launch('test/fixtures/supervisor.mjs', config.path, { FIXTURE_CHILD_MODE: mode });
	try {
		if (mode === 'shutdown-stall') {
			await supervisor.ready;
			supervisor.child.kill('SIGTERM');
		}
		expect((await supervisor.exit).code).toBe(1);
	} finally {
		await supervisor.close();
		await config.close();
	}
});

test('stops the process tree abnormally when a running Role publisher connection ends', async () => {
	const { Redis } = await import('ioredis');
	const { randomUUID } = await import('node:crypto');
	const { vi } = await import('vitest');
	const connectionName = `role-publisher-${randomUUID()}`;
	const config = await configuration({
		...database.config,
		redisForPubsub: { ...database.config.redisForPubsub, connectionName },
		http: { port: await freePort() },
	});
	const control = new Redis(database.config.redis);
	const supervisor = launch('built/entrypoints/supervisor.js', config.path);
	let children: { role: string; pid: number }[] = [];
	try {
		await supervisor.ready;
		children = (supervisor.messages.find((message: any) => message.role === 'supervisor') as { children: typeof children }).children;
		const clients = String(await control.client('LIST'));
		const publisher = clients.split('\n').find(line => line.includes(`name=${connectionName} `) && line.includes('flags=N '));
		expect(publisher).toBeDefined();
		await control.client('KILL', 'ID', publisher!.match(/^id=(\d+)/)![1]);
		await vi.waitFor(() => expect(supervisor.child.exitCode, supervisor.output()).toBe(1), { timeout: 2000 });
		expect((await supervisor.exit).code).toBe(1);
		for (const child of children) {
			expect(() => process.kill(child.pid, 0)).toThrow();
		}
	} finally {
		control.disconnect();
		await supervisor.close();
		await config.close();
	}
});
