/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import globals from 'globals';
import shared from '../shared/eslint.config.js';

export default [
	...shared,
	{ ignores: ['built/**', 'src/**', 'migration/**', 'exports/**'] },
	{ languageOptions: { globals: globals.node } },
	{
		rules: {
			curly: ['error', 'all'],
			'@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
		},
	},
];
