/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { toPuny } from './host.js';
import type { StartUserHashtags } from './user-hashtags.js';
import type { TransactionRunner } from '../../application/transaction.js';
import type { RemoteActorCreateScope, RemoteActorPlan } from './remote-actor.js';

export interface Account {
	username: string;
	host: string | null;
}
export interface ResolvedUser extends Account {
	id: string;
	uri: string | null;
}
export interface RemoteUserFacts extends ResolvedUser {
	tags: readonly string[];
	lastFetchedAtMs: number | null;
	isDeleted: boolean;
	movedToUri?: string | null;
}
export function normalizeAccount(account: Account, selfHost: string): Account {
	const host = account.host === null ? null : toPuny(account.host);
	return { username: account.username.toLowerCase(), host: host === toPuny(selfHost) ? null : host };
}
export function classifyRemoteUser(facts: RemoteUserFacts | null, now: number): 'missing' | 'fresh' | 'stale' {
	if (!facts) {
		return 'missing';
	}
	return facts.host !== null && (facts.lastFetchedAtMs === null || now - facts.lastFetchedAtMs > 86400000) ? 'stale' : 'fresh';
}
export interface RemoteUserPorts {
	selfHost: string;
	startUserHashtags: StartUserHashtags;
	localId(uri: string): string | null;
	readByAccount(account: Account): Promise<RemoteUserFacts | null>;
	readByUri(uri: string): Promise<RemoteUserFacts | null>;
	readLocal(id: string): Promise<RemoteUserFacts | null>;
	markAttempt(id: string, now: number): Promise<void>;
	repairUri(id: string, uri: string): Promise<void>;
	webfinger(account: Account): Promise<string>;
	acquireActor(uri: string, existing: RemoteUserFacts | null, currentTime: () => number, newId: (now: number) => string): Promise<RemoteActorPlan>;
	insertActor(scope: RemoteActorCreateScope, plan: RemoteActorPlan): Promise<ResolvedUser>;
	refreshActor(id: string, plan: RemoteActorPlan): Promise<'updated' | 'skip'>;
	actorTransactions: TransactionRunner<RemoteActorCreateScope>;
}

export function webfingerUrl(query: string, useHttp: boolean): string {
	if (/^https?:\/\//.test(query)) {
		const u = new URL(query);
		return `${u.protocol}//${u.hostname}/.well-known/webfinger?${new URLSearchParams({ resource: query })}`;
	}
	const match = query.match(/^([^@]+)@(.*)/);
	if (!match) {
		throw new Error(`Invalid query (${query})`);
	}
	return `http${useHttp ? '' : 's'}://${match[2]}/.well-known/webfinger?${new URLSearchParams({ resource: `acct:${query}` })}`;
}
export function selectWebfingerSelf(finger: {
	links: {
		rel?: string;
		href: string;
	}[];
}): string {
	const self = finger.links.find(link => link.rel != null && link.rel.toLowerCase() === 'self');
	if (!self) {
		throw new Error('self link not found');
	}
	return self.href;
}
