/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import ts from 'typescript';
import { setup, note } from '../../helpers/note-translate.js';

const source = readFileSync(new URL('../../fixtures/note-translate/translate.ts.txt', import.meta.url), 'utf8');
const javascript = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const declarations = source.slice(source.indexOf('export const meta ='), source.indexOf('@Injectable()')).replaceAll('export const', 'const');
const meta = new Function(`${javascript(declarations)}; return meta;`)();
const callback = source.slice(source.indexOf('async (ps, me) => {'), source.lastIndexOf('\n\t\t});'));
const makeSource = new Function('ApiError', 'meta', `${javascript(`const handler = ${callback};`)}; return handler;`);

const cases = [
	{ id: 'free', options: {} }, { id: 'pro', options: { pro: true } },
	{ id: 'plain', options: { note: { cw: null } } },
	{ id: 'cw-only', options: { note: { text: null } } },
	{ id: 'empty-cw', options: { note: { cw: '', text: null } } },
	{ id: 'empty-key-valid', options: { key: '' } },
	{ id: 'blank-without-key', options: { key: null, note: { text: ' \n', cw: null } } },
	{ id: 'null-without-key', options: { key: null, note: { text: null, cw: null } } },
	{ id: 'policy-before-missing', options: { allowed: false, note: null } },
	{ id: 'policy-before-empty', options: { allowed: false, note: { text: '', cw: null } } },
	{ id: 'missing', options: { note: null } },
	{ id: 'invisible-before-key', options: { note: { visibility: 'specified' as const }, key: null } },
	{ id: 'hidden-before-empty', options: { hidden: true, note: { text: '', cw: null } } },
	{ id: 'missing-key', options: { key: null } },
	{ id: 'transport-failure', options: { fail: true } },
	{ id: 'empty-translations', options: { response: { translations: [] } } },
	{ id: 'missing-translations', options: { response: {} } },
	{ id: 'missing-response-fields', options: { response: { translations: [{}] } } },
	{ id: 'first-translation-only', options: { response: { translations: [{ detected_source_language: 'JA', text: 'one' }, { detected_source_language: 'EN', text: 'two' }] } } },
];

test('translation fixture binds the exact fixed upstream file', () => {
	expect(createHash('sha256').update(source).digest('hex')).toBe('4391eae48a336feccb097575c9c2677183f3a348197abbf0434949425cb25e9e');
});
test.each(cases)('$id matches the literal pinned endpoint result and outbound request', async ({ options }) => {
	const expectedCalls: unknown[] = [];
	const bindings = {
		serverSettings: { deeplAuthKey: options.key === undefined ? 'test-key' : options.key, deeplIsPro: options.pro ?? false },
		roleService: { getUserPolicies: async () => ({ canUseTranslator: options.allowed ?? true }) },
		getterService: { getNote: async () => {
			if (options.note === null) {
				throw Object.assign(new Error('No such note'), { id: '9725d0ce-ba28-4dde-95a7-2cbb2c15de24' });
			}
			return { ...note, ...options.note };
		} },
		noteEntityService: { isVisibleForMe: async () => options.note?.visibility !== 'specified', pack: async () => ({ isHidden: options.hidden ?? false }) },
		httpRequestService: { send: async (url: string, request: object) => {
			expectedCalls.push({ url, ...request });
			if (options.fail) {
				throw Error('test-key in unsafe transport failure');
			}
			return { json: async () => options.response ?? { translations: [{ detected_source_language: 'EN', text: 'こんにちは' }] } };
		} },
	};
	class ApiError extends Error {
		constructor(readonly definition: { code: string; message: string; id: string }) {
			super(definition.code);
		}
	}
	const pinned = makeSource.call(bindings, ApiError, meta);

	async function observe(run: () => Promise<unknown>) {
		try {
			return { result: await run() };
		} catch (error) {
			return error instanceof ApiError ? { code: error.definition.code }
				: error instanceof Error && 'code' in error ? { code: error.code } : { failed: true };
		}
	}

	const target = setup(options);
	const expected = await observe(() => pinned({ noteId: note.id, targetLang: 'JA-JP' }, { id: 'viewer' }));
	expect(await observe(() => target.run())).toEqual(expected);
	expect(target.calls).toEqual(expectedCalls);
});
