/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { StreamFacts, StreamNote } from './policy.js';
import type { QueueStatsReader } from '../queue/public.js';

export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface StreamPorts {
	facts(): StreamFacts;
	hidingFollowing?(): Promise<ReadonlySet<string>>;
	now(): number;
	send(value: { type: string; body: unknown }): void;
	repack(id: string): Promise<Record<string, unknown> | null>;
	reaction(note: StreamNote): Promise<string | undefined>;
	tokenPermissions?: readonly string[];
	queueStats?: QueueStatsReader;
}

export interface StreamPublication {
	channel: string;
	message: unknown;
	facts: StreamFacts;
	hidingFollowing?(): Promise<ReadonlySet<string>>;
}

export interface StreamChannel {
	publish?(publication: StreamPublication): Promise<void>;
	onMessage?(type: string, body: unknown): void;
	dispose?(): void;
}

export interface StreamChannelDefinition {
	requireCredential: boolean;
	kind: string | null;
	shouldShare: boolean;
	create(context: { params: Record<string, unknown>; send(type: string, body: unknown): void }): StreamChannel | null;
}
