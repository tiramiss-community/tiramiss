/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineAsyncComponent } from 'vue';
import type { BasicTimelineType } from '@/timelines.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';

export type PastTimelineWindowOptions = {
	src: BasicTimelineType | 'list' | 'antenna' | 'channel';
	title: string;
	list?: string;
	antenna?: string;
	channel?: string;
	withRenotes?: boolean;
	withReplies?: boolean;
	withSensitive?: boolean;
	withLocalOnly?: boolean;
	onlyFiles?: boolean;
};

function pad2(value: number): string {
	return value.toString().padStart(2, '0');
}

export function formatDatetimeLocal(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export async function openPastTimelineWindow(options: PastTimelineWindowOptions): Promise<void> {
	const { canceled, result } = await os.inputDatetime({
		title: i18n.ts.jumpToSpecifiedDate,
		default: formatDatetimeLocal(new Date()),
	});
	if (canceled || result == null) return;

	const initialDate = result.getTime();
	if (Number.isNaN(initialDate)) return;

	const { dispose } = os.popup(defineAsyncComponent(() => import('@/components/MkPastTimelineWindow.vue')), {
		...options,
		initialDate,
	}, {
		closed: () => dispose(),
	});
}
