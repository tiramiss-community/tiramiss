/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = 'docs/superpowers/compatibility/backend-inventory';
const backend = 'packages/backend/src/';

function parse(source) {
	const tree = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	if (tree.parseDiagnostics.length > 0) {
		throw new Error('Cannot parse TypeScript inventory source');
	}
	return tree;
}

function walk(tree, visitor) {
	visitor(tree);
	ts.forEachChild(tree, node => walk(node, visitor));
}

function text(node, tree) {
	return ts.isStringLiteralLike(node) ? node.text : node.getText(tree);
}

function scopeOf(node, tree) {
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) {
			return parent.name?.getText(tree) ?? '(anonymous)';
		}
	}
	return '(module)';
}

function lineOf(node, tree) {
	return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
}

export function extractApiRegistry(source) {
	const tree = parse(source);
	return tree.statements.filter(ts.isExportDeclaration).map(node => {
		if (!node.exportClause || !ts.isNamespaceExport(node.exportClause) || !node.moduleSpecifier) {
			throw new Error('Unsupported API registry export');
		}
		return {
			name: text(node.exportClause.name, tree),
			source: posix.normalize(`${backend}server/api/${text(node.moduleSpecifier, tree).replace(/\.js$/, '.ts')}`),
			line: lineOf(node, tree),
		};
	});
}

export function validateApiCoverage(registered, endpointFiles) {
	const sources = new Set(registered.map(row => row.source));
	if (registered.length !== endpointFiles.length || sources.size !== endpointFiles.length
		|| endpointFiles.some(path => !sources.has(path))) {
		throw new Error('API registry/handler coverage mismatch');
	}
}

export function extractHttpRoutes(source, contents) {
	const tree = parse(contents);
	const routes = [];
	const constants = [];
	const lexicalScope = node => {
		while (node.parent && !ts.isBlock(node) && !ts.isSourceFile(node)) {
			node = node.parent;
		}
		return node;
	};
	walk(tree, node => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)
			&& (node.parent.flags & ts.NodeFlags.Const)) {
			constants.push({ name: node.name.text, value: node.initializer, scope: lexicalScope(node) });
		}
	});
	walk(tree, node => {
		if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
			|| node.expression.expression.getText(tree) !== 'fastify') {
			return;
		}
		const operation = node.expression.name.text;
		if (!['get', 'post', 'put', 'patch', 'delete', 'all', 'head', 'options', 'route'].includes(operation)) {
			return;
		}
		let path = node.arguments[0];
		let method = operation.toUpperCase();
		let constraints = '';
		if (operation === 'route') {
			if (!path || !ts.isObjectLiteralExpression(path)) {
				throw new Error(`Unsupported route object: ${source}`);
			}
			const fields = path.properties.filter(ts.isPropertyAssignment);
			const methodNode = fields.find(p => text(p.name, tree) === 'method')?.initializer;
			path = fields.find(p => text(p.name, tree) === 'url')?.initializer;
			if (!methodNode) {
				throw new Error(`Missing route method: ${source}`);
			}
			method = ts.isArrayLiteralExpression(methodNode) ? methodNode.elements.map(n => text(n, tree)).join(',') : text(methodNode, tree);
		} else if (node.arguments.length > 2) {
			const options = node.arguments[1];
			if (ts.isObjectLiteralExpression(options)) {
				constraints = options.properties.filter(ts.isPropertyAssignment).find(p => text(p.name, tree) === 'constraints')?.initializer.getText(tree) ?? '';
			}
		}
		if (!path) {
			throw new Error(`Missing route path: ${source}`);
		}
		if (ts.isIdentifier(path)) {
			for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
				const constant = constants.find(c => c.name === path.text && c.scope === ancestor);
				if (constant) {
					path = constant.value;
					break;
				}
			}
		}
		const line = lineOf(node, tree);
		routes.push({ id: `http:${source}:${line}`, name: `${method} ${text(path, tree)}`, method,
			path: text(path, tree), dynamic: !ts.isStringLiteralLike(path), scope: scopeOf(node, tree), constraints, source, line });
	});
	return routes;
}

export function extractCases(source) {
	const tree = parse(source);
	const cases = [];
	walk(tree, node => {
		if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) {
			cases.push({ name: node.expression.text, scope: scopeOf(node, tree), line: lineOf(node, tree) });
		}
	});
	return cases;
}

export function extractActivities(source) {
	const tree = parse(source);
	const activities = [];
	walk(tree, node => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && scopeOf(node, tree) === 'performOneActivity') {
			const match = /^is([A-Z]\w+)$/.exec(node.expression.text);
			if (match) {
				activities.push({ name: match[1], line: lineOf(node, tree) });
			}
		}
	});
	return activities;
}

export function extractSchedules(source) {
	const tree = parse(source);
	const schedules = [];
	walk(tree, node => {
		if (!ts.isVariableDeclaration(node) || node.name.getText(tree) !== 'REPEATABLE_SYSTEM_JOB_DEF') {
			return;
		}
		if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer)) {
			throw new Error('Unsupported repeatable job definition');
		}
		for (const definition of node.initializer.elements) {
			if (!ts.isObjectLiteralExpression(definition)) {
				throw new Error('Unsupported scheduled job');
			}
			const fields = Object.fromEntries(definition.properties.filter(ts.isPropertyAssignment).map(p => [text(p.name, tree), text(p.initializer, tree)]));
			if (!fields.name || !fields.pattern) {
				throw new Error('Missing scheduled job name/pattern');
			}
			schedules.push({ name: fields.name, pattern: fields.pattern, line: lineOf(definition, tree) });
		}
	});
	return schedules;
}

export function assignDomain(name, domains) {
	const matches = domains.flatMap(domain => {
		if (domain.apiNames?.includes(name)) {
			return [{ id: domain.id, weight: Number.MAX_SAFE_INTEGER }];
		}
		const prefixes = domain.apiPrefixes?.filter(prefix => name.startsWith(prefix)) ?? [];
		return prefixes.length ? [{ id: domain.id, weight: Math.max(...prefixes.map(p => p.length)) }] : [];
	});
	const best = matches.filter(m => m.weight === Math.max(...matches.map(x => x.weight)));
	if (best.length !== 1) {
		throw new Error(`${best.length ? 'Ambiguous' : 'Unassigned'} API domain: ${name}`);
	}
	return best[0].id;
}

export function validateCatalog(catalog, domains, { upstreamFiles, implementationFiles }) {
	const ids = new Set();
	const domainIds = new Set();
	const references = (paths = []) => {
		for (const path of paths) {
			if (!implementationFiles.has(path)) {
				throw new Error(`Missing implementation/test reference: ${path}`);
			}
		}
	};
	for (const domain of domains) {
		if (domainIds.has(domain.id)) {
			throw new Error(`Duplicate domain: ${domain.id}`);
		}
		domainIds.add(domain.id);
		if (!Number.isSafeInteger(domain.issue) || domain.issue <= 0) {
			throw new Error(`Missing owner issue: ${domain.id}`);
		}
		for (const field of ['scope', 'persistence', 'effects', 'differences']) {
			if (domain[field] == null) {
				throw new Error(`Missing domain field ${field}: ${domain.id}`);
			}
		}
		for (const path of domain.upstreamReferences ?? []) {
			if (!upstreamFiles.has(path)) {
				throw new Error(`Invalid domain source: ${path}`);
			}
		}
		references(domain.implementation);
		references(domain.verification);
	}
	for (const contract of catalog.contracts) {
		if (ids.has(contract.id)) {
			throw new Error(`Duplicate contract: ${contract.id}`);
		}
		ids.add(contract.id);
		if (!domainIds.has(contract.domain)) {
			throw new Error(`Unknown contract domain: ${contract.id}`);
		}
		if (!upstreamFiles.has(contract.source) || !Number.isInteger(contract.line) || contract.line < 1) {
			throw new Error(`Invalid upstream source: ${contract.id}`);
		}
		for (const path of contract.references ?? []) {
			if (!upstreamFiles.has(path)) {
				throw new Error(`Invalid contract source reference: ${path}`);
			}
		}
		if (!['not_implemented', 'partial', 'verified'].includes(contract.status)) {
			throw new Error(`Invalid status: ${contract.id}`);
		}
		if (contract.status !== 'not_implemented' && (!contract.implementation?.length || !contract.verification?.length)) {
			throw new Error(`Missing implementation/test evidence: ${contract.id}`);
		}
		references(contract.implementation);
		references(contract.verification);
	}
}

function git(...args) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

export function buildCatalog(configuration) {
	const { upstreamCommit, implementationCommit, domains, sources, capabilities, overrides } = configuration;
	for (const commit of [upstreamCommit, implementationCommit]) {
		if (!/^[a-f0-9]{40}$/.test(commit)) {
			throw new Error('Inventory revisions must be full immutable SHAs');
		}
	}
	const files = new Set(git('ls-tree', '-r', '--name-only', upstreamCommit).trim().split('\n'));
	const implementationFiles = new Set(git('ls-tree', '-r', '--name-only', implementationCommit).trim().split('\n'));
	const read = path => git('show', `${upstreamCommit}:${path}`);
	const contracts = [];
	const add = (kind, row, domain) => contracts.push({ ...row, kind, domain, status: 'not_implemented' });
	const registry = `${backend}server/api/endpoint-list.ts`;
	const registered = extractApiRegistry(read(registry));
	const endpointFiles = [...files].filter(p => p.startsWith(`${backend}server/api/endpoints/`) && p.endsWith('.ts') && !p.endsWith('.test.ts'));
	validateApiCoverage(registered, endpointFiles);
	for (const row of registered) {
		add('api', { id: `api:${row.name}`, name: row.name, source: row.source, line: 1, registryLine: row.line }, assignDomain(row.name, domains));
	}
	for (const source of [...files].filter(p => p.startsWith(`${backend}server/`) && p.endsWith('.ts') && !p.endsWith('.test.ts'))) {
		for (const route of extractHttpRoutes(source, read(source))) {
			let domain = sources.http[source];
			if (source.endsWith('/ApiServerService.ts')) {
				domain = ['/signup', '/signin-flow', '/signin-with-passkey', '/signup-pending', '/miauth/:session/check'].includes(route.path) ? 'identity'
					: route.path === '/v1/instance/peers' ? 'federation' : route.path === '/clear-browser-cache' ? 'web' : 'api-common';
			}
			if (source.endsWith('/WellKnownServerService.ts')) {
				domain = route.path === '/.well-known/webfinger' ? 'federation'
					: ['/.well-known/oauth-authorization-server', '/.well-known/change-password'].includes(route.path) ? 'identity' : domain;
			}
			if (!domain) {
				throw new Error(`Unassigned HTTP source: ${source}`);
			}
			const mount = source.endsWith('/ApiServerService.ts') ? '/api'
				: source.endsWith('/OAuth2ProviderService.ts') ? (route.scope === 'createTokenServer' ? '/oauth/token' : '/oauth')
					: source.endsWith('/HealthServerService.ts') ? '/healthz' : '';
			const name = `${route.method} ${route.dynamic ? `${mount} + (${route.path})` : `${mount}${route.path}`}`;
			add('http', { ...route, name, mount }, domain);
		}
	}
	for (const [source, kinds] of Object.entries(sources.cases)) {
		for (const row of extractCases(read(source))) {
			const kind = kinds[row.scope];
			if (!kind) {
				throw new Error(`Unassigned dispatch scope: ${source}:${row.scope}`);
			}
			const references = kind === 'stream-channel' ? [sources.channels[row.name]] : [];
			add(kind, { ...row, id: `${kind}:${source}:${row.line}`, source, ...(references.length ? { references } : {}) }, kind === 'stream-channel' || kind === 'stream-command' ? 'stream' : kind === 'cli' ? 'operations' : sources.jobs[row.name]);
		}
	}
	for (const source of [...files].filter(p => p.startsWith(`${backend}queue/processors/`) && p.endsWith('.ts'))) {
		const name = posix.basename(source, 'ProcessorService.ts');
		add('processor', { id: `processor:${name}`, name, source, line: 1 }, sources.processors[name]);
	}
	const inbox = `${backend}core/activitypub/ApInboxService.ts`;
	for (const row of extractActivities(read(inbox))) {
		add('ap-inbound', { ...row, id: `ap-inbound:${row.name}`, source: inbox }, 'federation');
	}
	const queue = `${backend}core/QueueService.ts`;
	for (const row of extractSchedules(read(queue))) {
		add('schedule', { ...row, id: `schedule:${row.name}`, source: queue }, sources.jobs[row.name]);
	}
	for (const capability of capabilities) {
		add('capability', capability, capability.domain);
	}
	for (const [id, override] of Object.entries(overrides)) {
		const contract = contracts.find(c => c.id === id);
		if (!contract) {
			throw new Error(`Unknown contract override: ${id}`);
		}
		Object.assign(contract, override);
	}
	contracts.sort((a, b) => a.id.localeCompare(b.id, 'en'));
	const catalog = { schemaVersion: 1, upstreamCommit, implementationCommit, contracts };
	validateCatalog(catalog, domains, { upstreamFiles: files, implementationFiles });
	return catalog;
}

function renderTable(catalog, domains) {
	const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
	const byId = new Map(domains.map(d => [d.id, d]));
	const status = { not_implemented: '未実装', partial: '部分実装', verified: '検証根拠あり' };
	const output = ['# 公開契約・保存/副作用の対応表', '', '`domains.json` と固定 Git オブジェクトから生成。入口・共通能力には重複があるため、行数は機能数でも進捗率の分母でもない。更新手順・状態の意味は [README](README.md)。', '',
		`本家: \`${catalog.upstreamCommit}\` / 新実装監査基準: \`${catalog.implementationCommit}\`。`, ''];
	for (const kind of [...new Set(catalog.contracts.map(c => c.kind))].sort()) {
		const contracts = catalog.contracts.filter(c => c.kind === kind);
		output.push(`## ${kind} (${contracts.length})`, '', '| 契約 | 領域 / 担当 Issue | 状態 | 本家の根拠 | 新実装・検証 |', '| --- | --- | --- | --- | --- |');
		for (const contract of contracts) {
			const domain = byId.get(contract.domain);
			const source = `[source](https://github.com/misskey-dev/misskey/blob/${catalog.upstreamCommit}/${contract.source}#L${contract.line})`;
			const refs = (contract.references ?? []).map(p => `[handler](https://github.com/misskey-dev/misskey/blob/${catalog.upstreamCommit}/${p})`).join(' ');
			const evidence = [...(contract.implementation ?? []), ...(contract.verification ?? [])].map(p => `[${posix.basename(p)}](../../../../${p})`).join(' / ') || '—';
			output.push(`| ${escape(contract.name)} | [${escape(domain.title)}](README.md#domain-${domain.id}) / [#${domain.issue}](https://github.com/tiramiss-community/tiramiss/issues/${domain.issue}) | ${status[contract.status]} | ${source} ${refs} | ${evidence} |`);
		}
		output.push('');
	}
	return `${output.join('\n').trimEnd()}\n`;
}

function main() {
	if (process.argv.length !== 3 || !['--write', '--check'].includes(process.argv[2])) {
		throw new Error('Usage: node scripts/backend-contract-inventory.mjs --write|--check');
	}
	const configuration = JSON.parse(readFileSync(resolve(root, directory, 'domains.json'), 'utf8'));
	const catalog = buildCatalog(configuration);
	const output = `${JSON.stringify({ ...catalog, contracts: undefined }, null, 2).slice(0, -2)},\n  "contracts": [\n${catalog.contracts.map(c => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`;
	for (const [name, contents] of [['contracts.json', output], ['contracts.md', renderTable(catalog, configuration.domains)]]) {
		const target = resolve(root, directory, name);
		if (process.argv[2] === '--write') {
			writeFileSync(target, contents);
		} else if (readFileSync(target, 'utf8') !== contents) {
			throw new Error(`Stale contract inventory ${name}; inspect sources/ownership then run --write`);
		}
	}
	const counts = Object.fromEntries([...new Set(catalog.contracts.map(c => c.kind))].sort().map(kind => [kind, catalog.contracts.filter(c => c.kind === kind).length]));
	console.log(`Inventory: OK ${JSON.stringify(counts)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
