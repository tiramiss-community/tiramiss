/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Ajv } from 'ajv';
import { InputInvalid } from './errors.js';

// 本家endpoint-baseと同じく、endpoint間で1つのAjvを共有し、既定値を入力へ書き込む。
const ajv = new Ajv({ useDefaults: true });
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);

export function compileInput<T>(schema: object): (input: unknown) => T {
	const validate = ajv.compile(schema);
	return input => {
		if (!validate(input)) {
			const error = validate.errors![0];
			throw new InputInvalid(error.schemaPath, error.message!);
		}
		return input as T;
	};
}
