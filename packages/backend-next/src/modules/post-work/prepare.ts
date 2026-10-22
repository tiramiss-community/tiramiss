/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { InvalidPostWorkRequest, WorkPayloadTooLarge } from './request.js';
import type { PostWorkRequest } from './request.js';

const payloadLimit = 2 * 1024 * 1024;
export const workCapacity = { rows: 1000000, bytes: 20 * 1024 ** 3, formulaVersion: 1 } as const;

function invalid(): never {
	throw new InvalidPostWorkRequest('Invalid post work request');
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)
		|| Object.getPrototypeOf(value) !== Object.prototype
		|| Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
		invalid();
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, max: number): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || Buffer.from(value).toString('utf8') !== value
		|| value.includes('\u0000') || Buffer.byteLength(value) > max) {
		invalid();
	}
}

function ids(value: unknown): asserts value is string[] {
	if (!Array.isArray(value) || value.length > 200000) {
		invalid();
	}
	for (const id of value) {
		text(id, 128);
	}
	if (new Set(value).size !== value.length) {
		invalid();
	}
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

export function chargedBytes(baseBytes: number, variable: string): number {
	return 1024 * Math.ceil(4 * (baseBytes + Buffer.byteLength(variable)) / 1024);
}

export function workHash(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

export function preparePostWork(input: unknown) {
	const request = object(input, ['requestId', 'eventId', 'noteId', 'actorId', 'note', 'noteGeneration', 'kind', 'schemaVersion', 'occurredAtMs', 'notBeforeMs', 'payload']);
	for (const key of ['requestId', 'eventId', 'noteId', 'actorId']) {
		text(request[key], 128);
	}
	if (request.schemaVersion !== 1 || ![1, 2].includes(request.noteGeneration as number)
		|| !Number.isSafeInteger(request.occurredAtMs) || !Number.isSafeInteger(request.notBeforeMs)
		|| (request.occurredAtMs as number) < 0 || (request.notBeforeMs as number) < (request.occurredAtMs as number)
		|| (request.notBeforeMs as number) > 8640000000000000 - 86400000) {
		invalid();
	}
	const note = object(request.note, ['visibility', 'localOnly', 'channelId']);
	if (!['public', 'home', 'followers', 'specified'].includes(note.visibility as string) || typeof note.localOnly !== 'boolean') {
		invalid();
	}
	if (note.channelId !== null) {
		text(note.channelId, 128);
		if (note.localOnly !== true || note.visibility !== 'public') {
			invalid();
		}
	}

	const items: { kind: 'ap.expand' | 'notification.create'; targetKey: string; payload: object }[] = [];
	if (request.kind === 'ap.expand') {
		const payload = object(request.payload, ['activity', 'directActorIds']);
		const activity = object(payload.activity, ['id', 'type', 'body']);
		text(activity.id, 2048);
		let url: URL;
		try {
			url = new URL(activity.id);
		} catch {
			invalid();
		}
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
			invalid();
		}
		if (!(request.noteGeneration === 1 ? ['Create', 'Announce'] : ['Delete', 'Undo']).includes(activity.type as string)) {
			invalid();
		}
		if (typeof activity.body !== 'string') {
			invalid();
		}
		if (Buffer.byteLength(activity.body) > payloadLimit) {
			throw new WorkPayloadTooLarge('The work payload exceeds the size limit');
		}
		text(activity.body, payloadLimit);
		let body;
		try {
			body = JSON.parse(activity.body);
		} catch {
			invalid();
		}
		if (body === null || typeof body !== 'object' || body.id !== activity.id || body.type !== activity.type) {
			invalid();
		}
		ids(payload.directActorIds);
		items.push({ kind: 'ap.expand', targetKey: 'all', payload: {} });
	} else if (request.kind === 'notification.create' && request.noteGeneration === 1) {
		const payload = object(request.payload, ['candidates']);
		if (!Array.isArray(payload.candidates) || payload.candidates.length === 0 || payload.candidates.length > 200000) {
			invalid();
		}
		const seen = new Set<string>();
		for (const value of payload.candidates) {
			const candidate = object(value, ['recipientId', 'type']);
			text(candidate.recipientId, 128);
			if (!['reply', 'mention', 'quote', 'renote', 'note'].includes(candidate.type as string)) {
				invalid();
			}
			const targetKey = JSON.stringify([candidate.recipientId, candidate.type]);
			if (seen.has(targetKey)) {
				invalid();
			}
			seen.add(targetKey);
			items.push({ kind: 'notification.create', targetKey, payload: candidate });
		}
	} else {
		invalid();
	}

	// Snapshot the validated values before the adapter yields to database I/O.
	const requestJson = canonical(request);
	const payloadJson = canonical(request.payload);
	const noteJson = canonical(request.note);
	if (Buffer.byteLength(requestJson) > payloadLimit) {
		throw new WorkPayloadTooLarge('The work payload exceeds the size limit');
	}
	return {
		request: JSON.parse(requestJson) as PostWorkRequest,
		payloadJson, noteJson, hash: workHash(payloadJson), items: structuredClone(items),
		deadlineAtMs: (request.notBeforeMs as number) + 86400000,
		deleting: request.noteGeneration === 2,
	};
}
