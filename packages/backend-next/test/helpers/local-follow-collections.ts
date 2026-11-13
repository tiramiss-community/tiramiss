/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import type { FollowCollectionDirection, FollowCollectionReader } from '../../src/modules/federation/local-follow-collections.js';

export interface FollowCollectionCase {
	id: string;
	direction: FollowCollectionDirection;
	size?: number;
	query?: string;
	method?: string;
	accept?: string | null;
	visibility?: string;
	otherVisibility?: string;
	missing?: boolean;
	ownerHost?: string;
	missingProfile?: boolean;
	suspended?: boolean;
	nullMember?: boolean;
	missingMember?: boolean;
	federation?: string;
	fail?: string;
}

const root = new URL('../../../../docs/superpowers/compatibility/remote-user/', import.meta.url);
export const followCorpus = JSON.parse(readFileSync(new URL('local-follow-collections-corpus.json', root), 'utf8')) as {
	defaults: { selfUrl: string; size: number };
	cases: FollowCollectionCase[];
};
export const followSource = JSON.parse(readFileSync(new URL('local-follow-collections-observations.json', root), 'utf8')) as {
	cases: { id: string; expected: { status: number; headers: Record<string, string | null>; json?: unknown; bodyEmpty: boolean; events: string[]; relationCursors: (string | null)[] } }[];
};

export function followFixture(c: FollowCollectionCase) {
	const events: string[] = [];
	const relationCursors: (string | null)[] = [];
	const event = (stage: string) => {
		events.push(stage);
		if (c.fail === stage) {
			throw Error(`${stage} unavailable`);
		}
	};
	const reader: FollowCollectionReader = {
		async readLocalUser() {
			event('user');
			return c.missing || c.ownerHost ? null : { id: 'alice', followersCount: 123, followingCount: 456 };
		},
		async readVisibility() {
			event('profile');
			if (c.missingProfile) {
				throw Error('profile missing');
			}
			return c.visibility ?? 'public';
		},
		async readRelations(_id, _direction, cursor) {
			event('relations');
			relationCursors.push(cursor || null);
			return Array.from({ length: c.size ?? followCorpus.defaults.size }, (_, i) => {
				const n = String(i + 1).padStart(3, '0');
				return { id: `r${n}`, memberId: `u${n}` };
			}).filter(r => !cursor || r.id < cursor).reverse().slice(0, 11);
		},
		async readMember(id) {
			event(`member:${id}`);
			if (c.missingMember) {
				throw Error('member missing');
			}
			return { id, host: Number(id.slice(1)) % 2 ? 'remote.test' : null, uri: c.nullMember ? null : `https://remote.test/${id}` };
		},
	};
	return { reader, events, relationCursors };
}
