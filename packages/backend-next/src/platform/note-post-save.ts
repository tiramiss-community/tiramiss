/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { setImmediate } from 'node:timers/promises';
import { DiagnosticError } from './diagnostic-error.js';
import type { NotePostSaveInput } from '../modules/note/public.js';
import type { Logger } from './logger.js';

/** 本家 NoteCreateService.postNoteCreated のうち、実装済みの後続処理をまとめる。 */
export function createNotePostSaveWork(steps: {
	counts(input: NotePostSaveInput): Promise<void>;
	schedulePollEnded(job: { noteId: string; delayMs: number }): Promise<void>;
	/** 保存済みの投稿を読み直し、配送するかどうかも自分で決める。 */
	deliver(noteId: string, input?: NotePostSaveInput): Promise<void>;
	featured?(input: NotePostSaveInput): Promise<void>;
	timelines?(input: NotePostSaveInput): Promise<void>;
	currentTime(): number;
}) {
	return async (input: NotePostSaveInput): Promise<void> => {
		const work = new Map<string, Promise<void>>();
		const start = (name: string, run: () => Promise<void>) => {
			try {
				work.set(name, run());
			} catch (error) {
				work.set(name, Promise.reject(error));
			}
		};
		start('counts', () => steps.counts(input));
		if (steps.featured) {
			start('featured', () => steps.featured!(input));
		}
		if (steps.timelines) {
			start('timelines', () => steps.timelines!(input));
		}
		if (input.pollExpiresAtMs !== null) {
			// 本家どおり後続処理の開始時刻から遅延を決める。期限を過ぎていても負の遅延のまま投入し、BullMQ はすぐに実行する。
			start('pollEnded', () => steps.schedulePollEnded({ noteId: input.noteId, delayMs: input.pollExpiresAtMs! - steps.currentTime() }));
		}
		start('deliver', () => steps.deliver(input.noteId, input));

		// 本家の加算・投入・配送は互いに独立しているため、1 つの失敗で他を省かない。
		const names = [...work.keys()];
		const results = await Promise.allSettled(work.values());
		const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ step: names[index], error: result.reason }] : []);
		if (failures.length > 0) {
			throw new DiagnosticError('NOTE_POST_SAVE_FAILED', { failures });
		}
	};
}

export function createNotePostSave(run: (input: NotePostSaveInput) => Promise<void>, logger: Logger) {
	const pending = new Set<Promise<void>>();

	// 待つ間に開始された処理も待つ。
	async function idle(): Promise<void> {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	}

	return {
		start(input: NotePostSaveInput): void {
			const work = setImmediate().then(() => run(input)).catch(error => {
				// 加算の欠けた行や投入されなかった投票終了ジョブを後から補えるよう、対象の ID と期限をすべて残す。
				logger.error('note-post-save.failed', { error, noteId: input.noteId, userId: input.userId, repliedNoteId: input.repliedNoteId, renotedNoteId: input.renotedNoteId, channelId: input.channelId, pollExpiresAtMs: input.pollExpiresAtMs });
			});
			pending.add(work);
			void work.then(() => pending.delete(work));
		},
		// 開始済みの後続処理がすべて終わるまで待つ。
		idle,
		close: idle,
	};
}
