/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
const mode = process.env.FIXTURE_CHILD_MODE;
if (mode !== 'startup-stall') process.send?.({ type: 'ready', role: process.env.FIXTURE_ROLE });
if (mode === 'shutdown-stall') process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => {
		process.exit(0);
	});
setInterval(() => {}, 1000);
