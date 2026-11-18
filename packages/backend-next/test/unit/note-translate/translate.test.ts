/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { NoteTranslationError } from '../../../src/modules/note-translate/public.js';
import { setup } from '../../helpers/note-translate.js';

test('translates raw CW and text with exact free/pro form and headers', async () => {
	for (const pro of [false, true]) {
		const { run, calls } = setup({ pro });
		expect(await run()).toEqual({ sourceLang: 'EN', text: 'こんにちは' });
		expect(calls).toEqual([{ url: `https://${pro ? 'api' : 'api-free'}.deepl.com/v2/translate`, method: 'POST', headers: { Authorization: 'DeepL-Auth-Key test-key', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, */*' }, body: 'text=CW%0A-----%0AHello+%26+goodbye&target_lang=JA' }]);
	}
});
test('empty text returns without configured key; an empty CW still adds the divider', async () => {
	expect(await setup({ key: null, note: { text: ' \n', cw: null } }).run()).toBeUndefined();
	await expect(setup({ key: null, note: { text: null, cw: '' } }).run()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
});
test.each([
	{ allowed: false, note: null, code: 'UNAVAILABLE' },
	{ note: null, code: 'NO_SUCH_NOTE' },
	{ note: { visibility: 'specified' as const }, code: 'CANNOT_TRANSLATE_INVISIBLE_NOTE' },
	{ hidden: true, code: 'CANNOT_TRANSLATE_INVISIBLE_NOTE' },
	{ key: null, code: 'UNAVAILABLE' },
])('rejects $code before outbound HTTP', async options => {
	const { run, calls } = setup(options);
	await expect(run()).rejects.toBeInstanceOf(NoteTranslationError);
	await expect(run()).rejects.toMatchObject({ code: options.code });
	expect(calls).toEqual([]);
});
test('transport failures use a fixed message and malformed responses fail', async () => {
	await expect(setup({ fail: true }).run()).rejects.toThrow('Note translation failed');
	await expect(setup({ response: { translations: [] } }).run()).rejects.toThrow('Note translation failed');
});

test('mentioned followers note remains translatable when following lookup is unavailable', async () => {
	expect(await setup({ note: { visibility: 'followers', mentions: ['viewer'] }, followingUnavailable: true }).run()).toEqual({ sourceLang: 'EN', text: 'こんにちは' });
});
test.each(['', 'en-US-extra', 'EN', 'pt_BR', '-GB'])('preserves target language prefix for %s', async target => {
	const { run, calls } = setup();
	await run(target);
	expect(new URLSearchParams((calls[0] as { body: string }).body).get('target_lang')).toBe(target.split('-')[0]);
});
