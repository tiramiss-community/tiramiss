/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Ajv } from 'ajv';

function pinned(name: string, sha256: string) {
	const source = readFileSync(new URL(`../fixtures/test-controls/${name}.ts.txt`, import.meta.url), 'utf8');
	assert.equal(createHash('sha256').update(source).digest('hex'), sha256);
	return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
}

const inputSource = pinned('test', '7cc82f4a8b0687027351342da0faede7e762e72bdb9cf646f3f318e96273730f');
const resetSource = pinned('reset-db', '613a81044f60f78bfa67ada44ba3d529adb0d1a240d2ee2ecaf16e7506689fe7');
const declaration = inputSource.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []).find(node => node.name.getText(inputSource) === 'paramDef');
assert.ok(declaration?.initializer);
const expression = declaration.initializer.getText(inputSource).replace(/ as const$/, '');
const ajv = new Ajv({ useDefaults: true });
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
export const pinnedTestInput = ajv.compile(new Function(`return (${expression});`)());

let handler: ts.Expression | undefined;

function visit(node: ts.Node): void {
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
		handler = node.arguments[2];
	}
	ts.forEachChild(node, visit);
}

visit(resetSource);
assert.ok(handler);
const javascript = ts.transpileModule(`const handler = ${handler.getText(resetSource)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

export async function pinnedResetEvents(environment: string): Promise<string[]> {
	const events: string[] = [];
	const context = {
		loggerService: { getLogger: () => ({ info: () => {} }) },
		redisClient: { flushdb: async () => {
			events.push('redis');
		} },
		db: {},
		metaService: { fetch: async () => {
			events.push('meta');
			return {};
		} },
		globalEventService: { publishInternalEvent: () => {
			events.push('event');
		} },
	};
	const execute = new Function('process', 'resetDb', 'setTimeout', `${javascript}\nreturn handler;`).call(context,
		{ env: { NODE_ENV: environment } }, async () => {
			events.push('database');
		}, (callback: () => void) => callback(),
	);
	await execute.call(context, {}, null);
	return events;
}
