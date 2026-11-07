/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Node preload only for the process fixture. Production runtime has no random override setting.
Math.random = () => 0.1;
