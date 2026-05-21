<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkWindow
	:initialWidth="520"
	:initialHeight="700"
	:canResize="true"
	:closeButton="true"
	@closed="emit('closed')"
>
	<template #header>
		<i class="ti ti-calendar-time" style="margin-right: 0.5em;"></i>
		<span>{{ title }}</span>
	</template>

	<div :class="$style.root">
		<div :class="$style.notice">
			<i class="ti ti-info-circle"></i>
			<span>{{ i18n.ts.showingPastTimeline }}</span>
		</div>
		<MkStreamingNotesTimeline
			:src="src"
			:list="list"
			:antenna="antenna"
			:channel="channel"
			:withRenotes="withRenotes"
			:withReplies="withReplies"
			:withSensitive="withSensitive"
			:withLocalOnly="withLocalOnly"
			:onlyFiles="onlyFiles"
			:initialDate="initialDate"
			:disableRealtime="true"
			:sound="false"
		/>
	</div>
</MkWindow>
</template>

<script lang="ts" setup>
import type { BasicTimelineType } from '@/timelines.js';
import MkStreamingNotesTimeline from '@/components/MkStreamingNotesTimeline.vue';
import MkWindow from '@/components/MkWindow.vue';
import { i18n } from '@/i18n.js';

withDefaults(defineProps<{
	src: BasicTimelineType | 'list' | 'antenna' | 'channel';
	initialDate: number;
	title: string;
	list?: string;
	antenna?: string;
	channel?: string;
	withRenotes?: boolean;
	withReplies?: boolean;
	withSensitive?: boolean;
	withLocalOnly?: boolean;
	onlyFiles?: boolean;
}>(), {
	list: undefined,
	antenna: undefined,
	channel: undefined,
	withRenotes: true,
	withReplies: true,
	withSensitive: true,
	withLocalOnly: true,
	onlyFiles: false,
});

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();
</script>

<style lang="scss" module>
.root {
	min-height: 100%;
	background: var(--MI_THEME-bg);
}

.notice {
	display: flex;
	gap: 8px;
	align-items: center;
	padding: 10px 12px;
	color: var(--MI_THEME-fg);
	background: var(--MI_THEME-panel);
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}
</style>
