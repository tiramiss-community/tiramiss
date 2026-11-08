/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { expect, expectTypeOf, test } from 'vitest';
import { DataSource } from 'typeorm';
import { entities, MiRole } from 'backend-upstream/entities';
import type { MiNote } from 'backend-upstream/entities';

test('loads copied entities without eagerly loading migration dependencies', async () => {
	const output = execFileSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
  import 'reflect-metadata';
  import { createRequire } from 'node:module';
  await import('backend-upstream/entities');
  const require = createRequire(import.meta.url);
  console.log(Object.keys(require.cache).some(path => /node_modules\\/(re2|tinycolor2)\\//.test(path)));
 `,
		],
		{ encoding: 'utf8' },
	);
	expect(output.trim()).toBe('false');
	const source = new DataSource({ type: 'postgres', entities });
	// Metadata construction validates cyclic relation targets without opening a DB.
	await (source as unknown as { buildMetadatas(): Promise<void>; }).buildMetadatas();
	expect(source.getMetadata(MiRole).tableName).toBe('role');
	expect(source.getMetadata('MiNote').tableName).toBe('note');
	expect(source.getMetadata('MiNote').columns.find(column => column.propertyName === 'visibility')?.enum).toEqual(['public', 'home', 'followers', 'specified']);
	expectTypeOf<MiNote['visibility']>().toEqualTypeOf<'public' | 'home' | 'followers' | 'specified'>();
	expect(source.getMetadata('MiChannel').tableName).toBe('channel');
	expect(source.getMetadata('MiNote').relations.find(relation => relation.propertyName === 'channel')?.inverseEntityMetadata.tableName).toBe('channel');
	expect(source.getMetadata('MiFollowing').relations.find(relation => relation.propertyName === 'follower')?.inverseEntityMetadata.tableName).toBe('user');
	expect(source.getMetadata('MiRelay').tableName).toBe('relay');
	expect(source.getMetadata('MiPoll').relations.find(relation => relation.propertyName === 'note')?.inverseEntityMetadata.tableName).toBe('note');
	expect(source.getMetadata('MiPollVote').tableName).toBe('poll_vote');
	expect(source.getMetadata('MiNoteReaction').tableName).toBe('note_reaction');
	expect(source.getMetadata('MiHashtag').tableName).toBe('hashtag');
	expect(source.getMetadata('MiAntenna').tableName).toBe('antenna');
	expect(source.getMetadata('MiAntenna').relations.find(value => value.propertyName === 'userList')?.inverseEntityMetadata.tableName).toBe('user_list');
	expect(source.entityMetadatas).toHaveLength(37);
	expect(source.getMetadata('MiWebhook').tableName).toBe('webhook');
	expect(source.getMetadata('MiWebhook').relations.find(value => value.propertyName === 'user')?.inverseEntityMetadata.tableName).toBe('user');
	for (const [model, table, relation] of [['MiMuting', 'muting', 'muter'], ['MiRenoteMuting', 'renote_muting', 'mutee'], ['MiNoteThreadMuting', 'note_thread_muting', 'user'], ['MiUserListMembership', 'user_list_membership', 'user']] as const) {
		expect(source.getMetadata(model).tableName).toBe(table);
		expect(source.getMetadata(model).relations.find(value => value.propertyName === relation)?.inverseEntityMetadata.tableName).toBe('user');
	}
	expect(source.getMetadata('MiUserListMembership').relations.find(value => value.propertyName === 'userList')?.inverseEntityMetadata.tableName).toBe('user_list');
	expect(source.getMetadata('MiChannelMuting').tableName).toBe('channel_muting');
	expect(source.getMetadata('MiChannelMuting').relations.find(value => value.propertyName === 'channel')?.inverseEntityMetadata.tableName).toBe('channel');
	expect(source.getMetadata('MiChannelFollowing').tableName).toBe('channel_following');
	expect(source.getMetadata('MiChannelFollowing').relations.find(value => value.propertyName === 'followee')?.inverseEntityMetadata.tableName).toBe('channel');
	expect(source.getMetadata('MiBlocking').tableName).toBe('blocking');
	expect(source.getMetadata('MiUserProfile').tableName).toBe('user_profile');
	expect(source.getMetadata('MiSystemAccount').tableName).toBe('system_account');
	expect(source.getMetadata('MiUserKeypair').tableName).toBe('user_keypair');
	expect(source.getMetadata('MiUserPublickey').tableName).toBe('user_publickey');
	expect(source.getMetadata('MiUsedUsername').tableName).toBe('used_username');
	expect(source.getMetadata('MiFollowRequest').tableName).toBe('follow_request');
	for (const relation of ['follower', 'followee']) {
		expect(source.getMetadata('MiFollowRequest').relations.find(value => value.propertyName === relation)?.inverseEntityMetadata.tableName).toBe('user');
	}
});
