/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import sharp from 'sharp';

export async function renderTwemojiBadge(path: string): Promise<Buffer> {
	const mask = await sharp(path, { density: 1000 })
		.resize(488, 488)
		.greyscale()
		.normalise()
		.linear(1.75, -(128 * 1.75) + 128)
		.flatten({ background: '#000' })
		.extend({ top: 12, bottom: 12, left: 12, right: 12, background: '#000' })
		.toColorspace('b-w')
		.png()
		.toBuffer();

	return sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
		.pipelineColorspace('b-w')
		.boolean(mask, 'eor')
		.resize(96, 96)
		.png()
		.toBuffer();
}
