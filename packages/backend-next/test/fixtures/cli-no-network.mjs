/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Socket } from 'node:net';
import { writeSync } from 'node:fs';

Socket.prototype.connect = function () {
	writeSync(2, 'Unexpected CLI network connection\n');
	throw new Error('CLI must not connect to dependencies');
};
