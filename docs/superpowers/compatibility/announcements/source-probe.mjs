/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { Brackets, DataSource, EntityNotFoundError } from '../../../../packages/backend-next/node_modules/typeorm/index.js';
import { MiAnnouncement, MiAnnouncementRead, MiUser } from '../../../../packages/backend-upstream/built/exports/entities.js';
import { createDataSource } from '../../../../packages/backend-next/built/platform/database/data-source.js';
import { migrateDatabase } from '../../../../packages/backend-next/built/platform/database/migrate.js';

const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const { Ajv } = require('ajv');
const root = new URL('../../../../', import.meta.url);
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const corpusBytes = readFileSync(new URL('./corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
const manifest = [];
const git = (...args) => execFileSync('git', args, { cwd: root });
function source(path) {
	const bytes = git('show', `${pin}:${path}`);
	manifest.push({ path, gitBlob: git('rev-parse', `${pin}:${path}`).toString().trim(), sha256: sha(bytes) });
	return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
class FixedDate extends Date {
	constructor(...args) { super(...(args.length ? args : [corpus.now])); }
	static now() { return Date.parse(corpus.now); }
}
class ApiError extends Error {
	constructor(meta) { super(meta.message); this.code = meta.code; this.id = meta.id; }
}
const globals = { Brackets, EntityNotFoundError, ApiError, Date: FixedDate };
const evaluate = text => vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022 }), globals);
function methods(path, names) {
	const sf = source(path);
	const cls = sf.statements.find(ts.isClassDeclaration);
	const selected = names.map(name => {
		const method = cls.members.find(member => member.name?.getText(sf) === name);
		assert(method, `${path} ${name}`);
		return method.getText(sf).replaceAll(/@bindThis\s*/g, '');
	});
	return evaluate(`(class { ${selected.join('\n')} }).prototype`);
}
function endpoint(path) {
	const sf = source(path);
	const declarations = sf.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []);
	globals.meta = evaluate(`(${declarations.find(n => n.name.getText(sf) === 'meta').initializer.getText(sf)})`);
	const schema = evaluate(`(${declarations.find(n => n.name.getText(sf) === 'paramDef').initializer.getText(sf)})`);
	const ctor = sf.statements.find(ts.isClassDeclaration).members.find(ts.isConstructorDeclaration);
	const call = ctor.body.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword).expression;
	const callback = call.arguments[2];
	const handler = evaluate(`(() => { const meta = ${JSON.stringify(globals.meta)}; return async function(${callback.parameters.map(p => p.getText(sf)).join(',')}) ${callback.body.getText(sf)}; })()`);
	const ajv = new Ajv({ useDefaults: true });
	ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
	return { handler, validate: ajv.compile(schema), access: JSON.parse(JSON.stringify(globals.meta)) };
}
const serviceMethods = methods('packages/backend/src/core/AnnouncementService.ts', ['getUnreadAnnouncements', 'getAnnouncement', 'read']);
const packMethods = methods('packages/backend/src/core/entities/AnnouncementEntityService.ts', ['pack', 'packMany']);
const queryMethods = methods('packages/backend/src/core/QueryService.ts', ['makePaginationQuery']);
const eventMethods = methods('packages/backend/src/core/GlobalEventService.ts', ['publish', 'publishMainStream']);
const endpoints = Object.fromEntries(['announcements', 'announcements/show', 'i/read-announcement'].map(name => [name, endpoint(`packages/backend/src/server/api/endpoints/${name}.ts`)]));
for (const path of ['packages/backend/src/models/Announcement.ts', 'packages/backend/src/models/AnnouncementRead.ts', 'packages/backend/test/e2e/announcements.ts']) {
	source(path);
}
const config = {
	host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT ?? 55432),
	database: 'backend_next_test', username: 'postgres', password: 'foundation-test-only', extra: {},
};
const admin = await new DataSource({ type: 'postgres', ...config }).initialize();
const database = `announcement_source_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${database}"`);
let db;
const cases = [];
try {
	config.database = database;
	await migrateDatabase(config);
	db = await createDataSource(config).initialize();
	const announcementsRepository = db.getRepository(MiAnnouncement);
	const announcementReadsRepository = db.getRepository(MiAnnouncementRead);
	await db.getRepository(MiUser).insert(corpus.users.map(user => ({ ...user, usernameLower: user.username })));
	let sequence = 0;
	const idService = { gen: date => date ? `${Math.max(0, date - 946684800000).toString(36).padStart(8, '0')}00000000` : `90000000${String(++sequence).padStart(8, '0')}`, parse: id => ({ date: new Date(Number.parseInt(id.slice(0, 8), 36) + 946684800000) }) };
	const packer = Object.assign(Object.create(packMethods), { announcementsRepository, announcementReadsRepository, idService });
	const queryService = Object.assign(Object.create(queryMethods), { idService });
	let events = [];
	const globalEventService = Object.assign(Object.create(eventMethods), { config: { host: 'example.test' }, redisForPub: { publish: (topic, value) => { events.push({ topic, ...JSON.parse(value) }); } } });
	const service = Object.assign(Object.create(serviceMethods), { announcementsRepository, announcementReadsRepository, idService, announcementEntityService: packer, globalEventService });
	const handlerThis = { announcementsRepository, announcementEntityService: packer, queryService, announcementService: service };
	for (const item of corpus.cases) {
		await announcementReadsRepository.createQueryBuilder().delete().execute();
		await announcementsRepository.createQueryBuilder().delete().execute();
		if (item.rows.length) {
			await announcementsRepository.insert(item.rows.map(row => ({ ...row, updatedAt: row.updatedAt ? new Date(row.updatedAt) : null, autoArchiveAt: row.autoArchiveAt ? new Date(row.autoArchiveAt) : null })));
		}
		if (item.reads.length) {
			await announcementReadsRepository.insert(item.reads);
		}
		const steps = [];
		for (const step of item.steps) {
			events = [];
			let result;
			if (item.failure === 'reads-unavailable') {
				await db.query('ALTER TABLE announcement_read RENAME TO announcement_read_unavailable');
			}
			try {
				const endpoint = endpoints[step.endpoint];
				const input = structuredClone(step.input);
				if (!endpoint.validate(input)) {
					result = { error: { code: 'INVALID_PARAM' } };
				} else {
					const value = await endpoint.handler.call(handlerThis, input, step.viewer ? { id: step.viewer } : null);
					result = { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
				}
			} catch (error) {
				assert.notEqual(error.name, 'ReferenceError');
				result = { error: error instanceof ApiError ? { code: error.code, id: error.id, message: error.message } : { code: 'INTERNAL_ERROR' } };
			} finally {
				if (item.failure === 'reads-unavailable') {
					await db.query('ALTER TABLE announcement_read_unavailable RENAME TO announcement_read');
				}
			}
			const rows = await db.query('SELECT id, "isActive", "updatedAt" FROM announcement ORDER BY id');
			const reads = await db.query('SELECT "userId", "announcementId" FROM announcement_read ORDER BY "userId", "announcementId"');
			steps.push(JSON.parse(JSON.stringify({ ...result, rows, reads, events })));
		}
		cases.push({ id: item.id, steps });
	}
} finally {
	await db?.destroy();
	await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
	await admin.destroy();
}
const output = JSON.stringify({ upstreamCommit: pin, corpusSha256: sha(corpusBytes), sourceProbeSha256: sha(readFileSync(new URL(import.meta.url))), manifest, sourceExecution: 'literal pinned methods and Endpoint callbacks with actual migrated PostgreSQL repositories', doubles: corpus.doubles, access: Object.fromEntries(Object.entries(endpoints).map(([name, endpoint]) => [name, { requireCredential: endpoint.access.requireCredential, ...(endpoint.access.kind ? { kind: endpoint.access.kind } : {}) }])), cases }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') {
	writeFileSync(target, output);
} else {
	assert.equal(process.argv[2], '--check');
	assert.equal(readFileSync(target, 'utf8'), output);
}
console.log(`announcement fixed source / real PG: ${cases.length} cases, ${cases.reduce((count, item) => count + item.steps.length, 0)} steps ${process.argv[2]}`);
