/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import type { LocalActorFacts, LocalActorProfileFacts } from '../../src/modules/federation/public.js';

export interface ActorFieldsCase {
	id: string;
	user?: Partial<LocalActorFacts>;
	profile?: Partial<LocalActorProfileFacts>;
	fail?: 'profile' | 'media' | 'tags' | 'key' | 'conversion';
}
const root = new URL('../../../../docs/superpowers/compatibility/remote-user/', import.meta.url);
export const actorFieldsCorpus = JSON.parse(readFileSync(new URL('local-actor-fields-corpus.json', root), 'utf8')) as {
	defaults: { url: string; user: LocalActorFacts; profile: LocalActorProfileFacts };
	projection: string[];
	cases: ActorFieldsCase[];
};
export const actorFieldsSource = JSON.parse(readFileSync(new URL('local-actor-fields-observations.json', root), 'utf8')) as {
	cases: { id: string; expected: { json?: Record<string, unknown>; error?: { name: string; message: string }; events: string[] } }[];
};
export function actorFieldsProjection(body: Record<string, unknown>): Record<string, unknown> {
	const json = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
	return Object.fromEntries(actorFieldsCorpus.projection.filter(key => Object.hasOwn(json, key)).map(key => [key, json[key]]));
}
