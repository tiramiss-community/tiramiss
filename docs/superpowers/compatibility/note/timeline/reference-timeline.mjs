/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Run from any directory: node <this-file> <checkout-containing-fixed-git-objects>.
const repo = new URL('../../../../../', import.meta.url);
const require = createRequire(new URL('packages/backend-next/package.json', repo));
const ts = require('typescript');
const fixed = JSON.parse(readFileSync(new URL('packages/backend-upstream/upstream-sync.json', repo), 'utf8')).commit;
const upstream = process.argv[2] ?? fileURLToPath(repo);
const sourcePath = 'packages/backend/src/core/NoteCreateService.ts';
const source = execFileSync('git', ['show', `${fixed}:${sourcePath}`], { cwd: upstream, encoding: 'utf8' });
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'NoteCreateService');
const method = declaration.members.find(node => node.name?.getText(parsed) === 'pushToTl');
assert.ok(method, 'fixed upstream pushToTl exists');
const body = method.getText(parsed).replace(/@bindThis\s*/g, '');
const bindings = { IsNull: () => null, isReply: (note, viewerId) => note.replyId && note.replyUserId !== note.userId && note.replyUserId !== viewerId, process: { nextTick: () => {} }, Math: Object.assign(Object.create(Math), { random: () => 0.99 }) };
const upstreamExports = {};
const options = { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } };
new Function('exports', ...Object.keys(bindings), ts.transpileModule(`class Probe { ${body} }; exports.Probe = Probe;`, options).outputText)(upstreamExports, ...Object.values(bindings));
const next = {};
new Function('exports', ts.transpileModule(readFileSync(new URL('packages/backend-next/src/modules/note/timeline-plan.ts', repo), 'utf8'), options).outputText)(next);

const limits = { localUser: 301, remoteUser: 101, home: 303, list: 305, channel: 1001 };
const materials = {
	limits,
	followers: [{ followerId: 'follower', withReplies: false }, { followerId: 'reply-lover', withReplies: true }, { followerId: 'author', withReplies: false }],
	lists: [{ userListId: 'other-list', userListUserId: 'owner', withReplies: false }, { userListId: 'reply-list', userListUserId: 'reply-lover', withReplies: true }, { userListId: 'follower-list', userListUserId: 'follower', withReplies: false }, { userListId: 'own-list', userListUserId: 'author', withReplies: false }],
	channelFollowers: ['channel-reader', 'author'],
};
let count = 0;
for (const visibility of ['public', 'home', 'followers', 'specified']) {
	for (const userHost of [null, 'remote.test']) {
		for (const replyUserId of [null, 'author', 'follower', 'reply-lover', 'elsewhere']) {
			for (const replyUserHost of [null, 'remote.test']) {
				for (const fileIds of [[], ['file']]) {
					for (const channelId of [null, 'channel']) {
						for (const visibleUserIds of [[], ['author'], ['follower'], ['author', 'follower', 'reply-lover']]) {
							const note = { id: 'note', userId: 'author', userHost, visibility, visibleUserIds, replyId: replyUserId === null ? null : 'parent', replyUserId, replyUserHost, channelId, fileIds };
							const observed = [];
							const service = Object.assign(new upstreamExports.Probe(), {
								meta: { enableFanoutTimeline: true, perLocalUserUserTimelineCacheMax: limits.localUser, perRemoteUserUserTimelineCacheMax: limits.remoteUser, perUserHomeTimelineCacheMax: limits.home, perUserListTimelineCacheMax: limits.list },
								config: { perChannelMaxNoteCacheCount: limits.channel },
								redisForTimelines: { pipeline: () => ({ exec: () => {} }) },
								fanoutTimelineService: { push: (name, _id, maxlen) => observed.push({ name, maxlen }) },
								followingsRepository: { find: async () => materials.followers },
								userListMembershipsRepository: { find: async () => materials.lists },
								channelFollowingsRepository: { find: async () => materials.channelFollowers.map(followerId => ({ followerId })) },
							});
							await service.pushToTl(note, { id: note.userId, host: note.userHost });
							assert.deepEqual(next.planNoteTimelines(note, materials), observed, JSON.stringify(note));
							count++;
						}
					}
				}
			}
		}
	}
}
console.log(`PASS ${count} fixed-source routing cases (${fixed}). Repository and Redis doubles; not upstream HTTP/real Redis execution.`);
