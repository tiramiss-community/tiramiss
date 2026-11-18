/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import { isVisibleForViewer, readNotePlan, renderNote } from '../note/public.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
import type { NoteFactsReader } from '../note/public.js';
import type { OutboundSend } from '../../application/outbound-http.js';

export class NoteTranslationError extends Error {
	constructor(public readonly code: 'UNAVAILABLE' | 'NO_SUCH_NOTE' | 'CANNOT_TRANSLATE_INVISIBLE_NOTE') {
		super(code);
	}
}

export interface NoteTranslationPorts {
	readActor(userId: string): Promise<AccessFacts & { id: string; host: string | null }>;
	canUseTranslator(userId: string, now: number): Promise<boolean>;
	isFollowing(followerId: string, followeeId: string): Promise<boolean>;
	notes: Pick<NoteFactsReader, 'readNotes' | 'readMaterials'>;
	readSettings(): Promise<{ deeplAuthKey: string | null; deeplIsPro: boolean }>;
	send: OutboundSend;
}

const readInput = compileInput<{ noteId: string; targetLang: string }>({
	type: 'object', properties: { noteId: { type: 'string', format: 'misskey:id' }, targetLang: { type: 'string' } }, required: ['noteId', 'targetLang'],
});

export function createTranslateNote(ports: NoteTranslationPorts) {
	return { async translateNote(access: AccessRequest, input: unknown, now: number) {
		const credential = requireCredential(access.credential);
		const actor = await ports.readActor(credential.userId);
		access.authorize(actor);
		const { noteId, targetLang } = readInput(input);
		if (!await ports.canUseTranslator(actor.id, now)) {
			throw new NoteTranslationError('UNAVAILABLE');
		}
		const [note] = await ports.notes.readNotes([noteId]);
		if (!note) {
			throw new NoteTranslationError('NO_SUCH_NOTE');
		}
		const following = !isVisibleForViewer(note, actor, false) && note.visibility === 'followers' && await ports.isFollowing(actor.id, note.userId);
		if (!isVisibleForViewer(note, actor, following)) {
			throw new NoteTranslationError('CANNOT_TRANSLATE_INVISIBLE_NOTE');
		}
		const notes = await readNotePlan([noteId], ids => ids.length === 1 && ids[0] === noteId ? Promise.resolve([note]) : ports.notes.readNotes(ids));
		const materials = await ports.notes.readMaterials(notes, actor.id, now);
		if (renderNote(noteId, materials, actor.id, now).isHidden) {
			throw new NoteTranslationError('CANNOT_TRANSLATE_INVISIBLE_NOTE');
		}
		let text = note.text ?? '';
		if (note.cw !== null) {
			text = `${note.cw}\n-----\n${text}`;
		}
		if (text.trim() === '') {
			return;
		}
		const settings = await ports.readSettings();
		if (settings.deeplAuthKey === null) {
			throw new NoteTranslationError('UNAVAILABLE');
		}
		const body = new URLSearchParams({ text, target_lang: targetLang.split('-')[0] });
		try {
			const response = await ports.send(settings.deeplIsPro ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate', {
				method: 'POST', headers: { Authorization: `DeepL-Auth-Key ${settings.deeplAuthKey}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, */*' }, body: body.toString(),
			});
			const json = await response.json() as { translations: { detected_source_language: string; text: string }[] };
			return { sourceLang: json.translations[0].detected_source_language, text: json.translations[0].text };
		} catch {
			// The shared API envelope includes exception messages; transport errors can contain the auth header.
			throw new Error('Note translation failed');
		}
	} };
}
