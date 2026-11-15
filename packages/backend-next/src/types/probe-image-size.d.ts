/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
declare module 'probe-image-size' {
	import type { Readable } from 'node:stream';
	function probeImageSize(source: Readable): Promise<{
		width: number;
		height: number;
		wUnits: string;
		hUnits: string;
		orientation?: number;
	}>;
	export default probeImageSize;
}
