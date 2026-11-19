/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import ts from 'typescript';
import { Ajv } from 'ajv';
import { In } from 'typeorm';
import { MiEmoji, MiRole } from 'backend-upstream/entities';
import manifest from '../fixtures/admin-emojis/manifest.json' with { type: 'json' };
import type { EntityManager } from 'typeorm';

type SourceName = keyof typeof manifest.files;

function source(name: SourceName) {
	const code = readFileSync(new URL(`../fixtures/admin-emojis/${name}.ts.txt`, import.meta.url), 'utf8');
	if (createHash('sha256').update(code).digest('hex') !== manifest.files[name].sha256) {
		throw new Error(`Pinned emoji source drift: ${name}`);
	}
	return ts.createSourceFile(`${name}.ts`, code, ts.ScriptTarget.Latest, true);
}

function compile(code: string) {
	const output = ts.transpileModule(`(${code})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: false } }).outputText;
	return new Function('In', 'sqlLikeEscape', 'domainToASCII', `return ${output}`)(In, (text: string) => text.replace(/([\\%_])/g, '\\$1'), domainToASCII);
}

function method(file: SourceName, name: string) {
	const klass = source(file).statements.find(ts.isClassDeclaration)!;
	const node = klass.members.find(node => node.name?.getText() === name) as ts.MethodDeclaration;
	return compile(`function(${node.parameters.map(p => p.getText()).join(',')}) ${node.body!.getText()}`.replace(/^function/, node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword) ? 'async function' : 'function'));
}

function variable(file: SourceName, name: string) {
	return source(file).statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations).find(node => node.name.getText() === name)!.initializer!.getText();
}

/** Literal pinned endpoint callbacks, query/service methods and packers against the caller's real DB. */
export function createAdminEmojiSource(manager: EntityManager, idFromDate: (date: number) => string) {
	const repository = manager.getRepository(MiEmoji);
	const packer: Record<string, unknown> = { emojisRepository: repository, rolesRepository: manager.getRepository(MiRole) };
	for (const name of ['packDetailed', 'packDetailedMany', 'packDetailedAdmin', 'packDetailedAdminMany']) {
		packer[name] = method('EmojiEntityService', name).bind(packer);
	}
	const custom = { emojisRepository: repository };
	const utility = { toPuny: method('UtilityService', 'toPuny') };
	const receiver = {
		emojisRepository: repository, emojiEntityService: packer,
		customEmojiService: { fetchEmojis: method('CustomEmojiService', 'fetchEmojis').bind(custom) },
		utilityService: utility, idService: { gen: idFromDate },
		queryService: { makePaginationQuery: method('QueryService', 'makePaginationQuery').bind({ idService: { gen: idFromDate } }) },
	};
	const sortKeys = compile(variable('CustomEmojiService', 'fetchEmojisSortKeys'));
	const hostTypes = compile(variable('CustomEmojiService', 'fetchEmojisHostTypes'));
	const handlers = Object.fromEntries((['list', 'remote', 'v2'] as const).map(name => {
		const file = source(name);
		let callback: ts.Expression | undefined;

		function visit(node: ts.Node) {
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
				callback = node.arguments[2];
			}
			ts.forEachChild(node, visit);
		}

		visit(file);
		const schema = compile(variable(name, 'paramDef').replaceAll('fetchEmojisSortKeys', JSON.stringify(sortKeys)).replaceAll('fetchEmojisHostTypes', JSON.stringify(hostTypes)));
		const ajv = new Ajv({ useDefaults: true });
		ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
		const validate = ajv.compile(schema);
		const literal = callback as ts.ArrowFunction;
		const callbackFn = compile(`async function(${literal.parameters.map(p => p.getText()).join(',')}) ${literal.body.getText()}`).bind(receiver);
		return [name, async (input: object) => {
			const params = structuredClone(input);
			if (!validate(params)) {
				throw new SourceEmojiInputInvalid(validate.errors![0].schemaPath, validate.errors![0].message!);
			}
			return callbackFn(params, { id: 'actor' });
		}];
	}));
	return (operation: 'list' | 'remote' | 'v2', input: object) => handlers[operation](input) as Promise<unknown>;
}

export async function adminEmojiSourceAccess(facts: { root: boolean; administrator: boolean; policy: boolean; suspended: boolean; permissions: string[] | null }, operation: 'list' | 'remote' | 'v2') {
	class ApiError extends Error {
		constructor(readonly body: object) {
			super();
		}
	}
	const receiver = { meta: { rootUserId: facts.root ? 'actor' : 'root' }, roleService: {
		getUserRoles: async () => [{ isAdministrator: facts.administrator }],
		getUserPolicies: async () => ({ canManageCustomEmojis: facts.policy }),
	} };
	const wrapper = ts.transpileModule(`(async function(ep, user, token) { ${source('access').getFullText()} })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: false } }).outputText;
	try {
		await new Function('ApiError', `return ${wrapper}`)(ApiError).call(receiver, { meta: compile(variable(operation, 'meta')) }, { id: 'actor', isSuspended: facts.suspended }, facts.permissions === null ? null : { permission: facts.permissions });
		return null;
	} catch (error) {
		if (error instanceof ApiError) {
			return error.body;
		}
		throw error;
	}
}

export class SourceEmojiInputInvalid extends Error {
	constructor(readonly param: string, readonly reason: string) {
		super('Invalid param.');
	}
}
