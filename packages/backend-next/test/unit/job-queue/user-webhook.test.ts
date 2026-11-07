/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { userWebhookJob } from '../../../src/platform/job-queue/user-webhook.js';

test('webhook jobs snapshot destination and secret and retain upstream retry settings', () => {
	const job = userWebhookJob({ id: 'h', userId: 'u', url: 'https://example.test', secret: 's' }, 'note', { note: { id: 'n' } }, 123, 'event');
	expect(job).toEqual({ name: 'h', data: { webhookId: 'h', userId: 'u', to: 'https://example.test', secret: 's', type: 'note', content: { note: { id: 'n' } }, createdAt: 123, eventId: 'event' }, opts: { attempts: 4, backoff: { type: 'custom' }, removeOnComplete: { age: 604800, count: 30 }, removeOnFail: { age: 604800, count: 100 } } });
});

test('processor delivers the captured body and headers and does not wait for status update', async () => {
	const { createUserWebhookProcessor, userWebhookJob } = await import('../../../src/platform/job-queue/user-webhook.js');
	let sent: { url: string; options: any } | undefined;
	let release!: () => void;
	const update = new Promise<void>(resolve => {
		release = resolve;
	});
	const statuses: number[] = [];
	const processor = createUserWebhookProcessor({
		url: 'https://source.test:444',
		send: async (url, options) => {
			sent = { url, options }; return { status: 204 } as any;
		},
		update: async (_id, status) => {
			statuses.push(status); await update;
		}, report: () => {},
	});
	const job = userWebhookJob({ id: 'h', userId: 'u', url: 'https://old.test', secret: 'secret' }, 'note', { note: { id: 'n' } }, 123, 'event').data;
	expect(await processor.process(job)).toBe('Success');
	expect(sent?.url).toBe('https://old.test');
	expect(sent?.options.headers).toEqual({ 'User-Agent': 'Misskey-Hooks', 'X-Misskey-Host': 'source.test:444', 'X-Misskey-Hook-Id': 'h', 'X-Misskey-Hook-Secret': 'secret', 'Content-Type': 'application/json' });
	expect(JSON.parse(sent!.options.body)).toEqual({ server: 'https://source.test:444', hookId: 'h', userId: 'u', eventId: 'event', createdAt: 123, type: 'note', body: { note: { id: 'n' } } });
	expect(statuses).toEqual([204]);
	release(); await processor.idle();
});

test.each([[400, true], [408, true], [429, false], [500, false]] as const)('HTTP %i applies upstream terminal/retry classification', async (status, terminal) => {
	const { OutboundStatusError } = await import('../../../src/application/outbound-http.js');
	const { UnrecoverableError } = await import('bullmq');
	const { createUserWebhookProcessor, userWebhookJob } = await import('../../../src/platform/job-queue/user-webhook.js');
	const statuses: number[] = [];
	const processor = createUserWebhookProcessor({ url: 'https://source.test', send: async () => {
		throw new OutboundStatusError('failed', status, 'failure');
	}, update: async (_id, value) => {
		statuses.push(value);
	}, report: () => {} });
	const job = userWebhookJob({ id: 'h', userId: 'u', url: 'https://old.test', secret: '' }, 'note', { note: {} }, 1, 'event').data;
	const error = await processor.process(job).catch(error => error);
	expect(error instanceof UnrecoverableError).toBe(terminal);
	expect(statuses).toEqual([status]);
});

test('failed attempts are logged without the job secret or body', async () => {
	const { createUserWebhookJobProcessor, userWebhookJob } = await import('../../../src/platform/job-queue/user-webhook.js');
	const { createLogger } = await import('../../../src/platform/logger.js');
	const lines: string[] = [];
	const process = createUserWebhookJobProcessor(async () => {
		throw new Error('failure');
	}, createLogger('test', line => lines.push(line)));
	const data = userWebhookJob({ id: 'h', userId: 'u', url: 'https://old.test', secret: 'private-secret' }, 'note', { note: { text: 'private-body' } }, 1, 'event').data;
	await expect(process({ id: 'job', name: 'h', attemptsMade: 1, data })).rejects.toThrow('failure');
	expect(lines.join('\n')).toContain('job.failed');
	expect(lines.join('\n')).not.toContain('private-secret');
	expect(lines.join('\n')).not.toContain('private-body');
});
