/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import FFmpeg from 'fluent-ffmpeg';

/** The same 5% PNG frame as VideoProcessingService, with owned input bytes. */
export async function extractVideoFrame(bytes: Buffer): Promise<Buffer> {
	const directory = await mkdtemp(join(tmpdir(), 'misskey-video-'));
	try {
		const source = join(directory, 'input');
		await writeFile(source, bytes);
		await new Promise<void>((resolve, reject) => {
			FFmpeg({ source })
				.on('end', () => resolve())
				.on('error', reject)
				.screenshot({ folder: directory, filename: 'out.png', count: 1, timestamps: ['5%'] });
		});
		return await readFile(join(directory, 'out.png'));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
