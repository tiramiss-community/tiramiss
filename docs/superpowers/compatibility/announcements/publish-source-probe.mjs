/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const root = new URL('../../../../', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const corpusBytes = readFileSync(new URL('./publish-corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const manifest = [];
function method(path, name) {
	const bytes = execFileSync('git', ['show', `${corpus.upstreamRevision}:${path}`], { cwd: root });
	if (!manifest.some(entry => entry.path === path)) {
		manifest.push({ path, sha256: sha(bytes) });
	}
	const sf = ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
	const cls = sf.statements.find(ts.isClassDeclaration);
	const node = cls.members.find(member => member.name?.getText(sf) === name);
	assert(node);
	const async = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
	return vm.runInNewContext(ts.transpile(`(${async}function(${node.parameters.map(p => p.getText(sf)).join(',')}) ${node.body.getText(sf)})`, { target: ts.ScriptTarget.ES2022 }));
}
const read = method('packages/backend/src/core/AnnouncementService.ts', 'read');
const publish = method('packages/backend/src/core/GlobalEventService.ts', 'publish');
const publishMainStream = method('packages/backend/src/core/GlobalEventService.ts', 'publishMainStream');
let rejectDelivery;
let deliveryRejected = false;
const delivery = new Promise((_resolve, reject) => { rejectDelivery = reject; });
const observedDelivery = delivery.catch(() => { deliveryRejected = true; });
let publishAttempts = 0;
const events = { publish, publishMainStream, config: { host: 'example.test' }, redisForPub: { publish() { publishAttempts++; return delivery; } } };
let readCount = 0;
let isActive = true;
const service = {
	idService: { gen: () => corpus.newReadId },
	announcementReadsRepository: { async insert() { if (readCount) throw Error('unique violation'); readCount++; } },
	announcementsRepository: { async findOneBy() { return { id: corpus.announcementId, userId: corpus.userId }; }, async update(_id, patch) { isActive = patch.isActive; } },
	getUnreadAnnouncements: async () => [],
	globalEventService: events,
};
// If read awaited publication this race would fail before the delivery is rejected.
let timeout;
try {
	await Promise.race([
		read.call(service, { id: corpus.userId }, corpus.announcementId),
		new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(Error('source read awaited publication')), 2000); }),
	]);
} finally {
	clearTimeout(timeout);
}
assert.equal(deliveryRejected, false);
rejectDelivery(Error('PUBLISH unavailable'));
await observedDelivery;
await read.call(service, { id: corpus.userId }, corpus.announcementId);
const result = {
	upstreamRevision: corpus.upstreamRevision, corpusSha256: sha(corpusBytes), sourceProbeSha256: sha(readFileSync(new URL(import.meta.url))), manifest, doubles: corpus.doubles,
	case: corpus.case, outcome: { returnedBeforeDelivery: true, deliveryRejected, readCount, isActive, publishAttempts, duplicateWasNoOp: readCount === 1 && publishAttempts === 1 },
};
assert.deepEqual(result.outcome, { returnedBeforeDelivery: true, deliveryRejected: true, readCount: 1, isActive: false, publishAttempts: 1, duplicateWasNoOp: true });
const output = JSON.stringify(result, null, 2) + '\n';
const target = new URL('./publish-observations.json', import.meta.url);
if (process.argv[2] === '--write') {
	writeFileSync(target, output);
} else {
	assert.equal(process.argv[2], '--check');
	assert.equal(readFileSync(target, 'utf8'), output);
}
console.log(`announcement fixed source publication: 1 case ${process.argv[2]}`);
