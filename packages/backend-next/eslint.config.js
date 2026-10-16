/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import parser from '@typescript-eslint/parser';
import globals from 'globals';
import shared from '../shared/eslint.config.js';
export default [...shared, { languageOptions: { globals: globals.node } }, { ignores: ['built/**'] }, { files: ['**/*.ts'], languageOptions: { parser, globals: globals.node, parserOptions: { project: './tsconfig.test.json', tsconfigRootDir: import.meta.dirname } } }];
