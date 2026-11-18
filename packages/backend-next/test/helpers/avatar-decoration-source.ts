/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { MiAvatarDecoration } from 'backend-upstream/entities';
import type { EntityManager } from 'typeorm';

const hashes: Record<string, string> = {
	'access': '4692823e5f9edb979d38e065d0f399af316e712caedce702a38ae5db8fbd8248',
	'miRepository': '18a43ae460220f0744ad1a5ffc1d03d8d4ea950f1247b1bdf1b50c1e0138372f',
	'AvatarDecorationService': 'cc89e8630799358f6a486a1c0ec8fc6708d1f313aa7d1413b68bbff3f9c83d72',
	'create': '7c3095bdfae51f99f8888ad9fe99989bf33272a0c34a5c84d0c300b9bdbadff0',
	'delete': '64d1fe938f4c51f15d9943ce03384901f532b2a103936bd15d2647f7f10aecfa',
	'list': '031b4ff12196387a14972ffc4569ef23e6cb78ce1a2459adf705b96018a0bdc6',
	'update': 'b753e85435c3785ce248e234cb3bbe5b6cc1ad0a4aaf5244c25cca9fef1a40ab',
};

function source(name: string) {
	const code = readFileSync(new URL(`../fixtures/avatar-decoration-admin/${name}.ts.txt`, import.meta.url), 'utf8');
	if (createHash('sha256').update(code).digest('hex') !== hashes[name]) {
		throw new Error(`Pinned avatar decoration source drift: ${name}`);
	}
	return ts.createSourceFile(`${name}.ts`, code, ts.ScriptTarget.Latest, true);
}

function compile(text: string) {
	return new Function(`return (${ts.transpileModule(`(${text})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: false } }).outputText.replace(/;\s*$/, '')});`);
}

function compileInsertOne() {
	let method: ts.MethodDeclaration | undefined;

	function visit(node: ts.Node) {
		if (ts.isMethodDeclaration(node) && node.name.getText() === 'insertOne') {
			method = node;
		}
		ts.forEachChild(node, visit);
	}

	visit(source('miRepository'));
	const code = ts.transpileModule(`(async function(${method!.parameters.map(p => p.getText()).join(',')}) ${method!.body!.getText()})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: false } }).outputText;
	return new Function(`return ${code}`)();
}

/** Literal pinned service methods and endpoint callback; external repository/id/event/log bindings only. */
export function createAvatarDecorationSource(manager: EntityManager, id: string, createdAt: number, atMs: number) {
	const repository = manager.getRepository(MiAvatarDecoration);
	const events: { type: string; body: MiAvatarDecoration }[] = [];
	const logs: { actorId: string; type: string; info: object }[] = [];
	const serviceClass = source('AvatarDecorationService').statements.find(ts.isClassDeclaration)!;
	const receiver: Record<string, unknown> = {
		avatarDecorationsRepository: {
			insertOne: compileInsertOne().bind(repository),
			findOneByOrFail: repository.findOneByOrFail.bind(repository), update: repository.update.bind(repository), delete: repository.delete.bind(repository),
			find: repository.find.bind(repository),
		},
		idService: { gen: () => id },
		globalEventService: { publishInternalEvent(type: string, body: MiAvatarDecoration) {
			events.push({ type, body }); 
		} },
		moderationLogService: { log(actor: { id: string }, type: string, info: object) {
			logs.push({ actorId: actor.id, type, info }); 
		} },
	};
	const FixedDate = class extends Date {
		constructor(value?: string | number) {
			super(value ?? atMs); 
		}
	};
	for (const name of ['create', 'update', 'delete']) {
		const method = serviceClass.members.find(member => member.name?.getText() === name) as ts.MethodDeclaration;
		const code = ts.transpileModule(`(async function(${method.parameters.map(p => p.getText()).join(',')}) ${method.body!.getText()})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: false } }).outputText;
		receiver[name] = new Function('Date', `return ${code}`)(FixedDate).bind(receiver);
	}
	receiver.getAll = () => repository.find();
	const endpoints = Object.fromEntries(['create', 'update', 'delete', 'list'].map(name => {
		const file = source(name);
		let callback: ts.Expression | undefined;

		function visit(node: ts.Node) {
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
				callback = node.arguments[2];
			}
			ts.forEachChild(node, visit);
		}

		visit(file);
		const handle = compile(callback!.getText()).call({ avatarDecorationService: receiver, idService: { parse: () => ({ date: new Date(createdAt) }) } });
		return [name, handle];
	}));
	return { events, logs, call: (operation: string, params: object, actorId: string) => endpoints[operation](params, { id: actorId }) as Promise<unknown> };
}

export async function avatarDecorationSourceAccess(facts: { root: boolean; administrator: boolean; policy: boolean; suspended: boolean; permissions: string[] | null }, operation: string) {
	const endpoint = source(operation);
	const meta = endpoint.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations).find(node => node.name.getText() === 'meta')!.initializer!;
	class ApiError extends Error {
		constructor(readonly body: object) {
			super(); 
		}
	}
	const receiver = { meta: { rootUserId: facts.root ? 'actor' : 'root' }, roleService: {
		getUserRoles: async () => [{ isAdministrator: facts.administrator }],
		getUserPolicies: async () => ({ canManageAvatarDecorations: facts.policy }),
	} };
	// Compile the literal gate with its ApiError binding; root/role/policy values are explicit test facts.
	const wrapper = ts.transpileModule(`(async function(ep, user, token) { ${source('access').getFullText()} })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: false } }).outputText;
	try {
		await new Function('ApiError', `return ${wrapper}`)(ApiError).call(receiver, { meta: compile(meta.getText()).call({}) }, { id: 'actor', isSuspended: facts.suspended }, facts.permissions === null ? null : { permission: facts.permissions });
		return null;
	} catch (error) {
		if (error instanceof ApiError) {
			return error.body; 
		}
		throw error;
	}
}
