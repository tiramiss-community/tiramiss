/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { Context, Handler, Hono } from 'hono';

export interface ApiRequest {
	input: unknown;
	token: string | null | undefined;
}

/**
 * 本家ApiServerServiceが全API routeへ付けるCORS・Cache-Control・本文上限を付けてhandlerを登録する。
 * `/api/*`のようなprefixへ付けると、同じrouterへ合成した他のsub-app（actor・note）にも効くため、完全一致のパスにだけ付ける。
 */
export function registerApiRoute(app: Hono, path: string, handler: Handler): void {
	app.use(path, cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'POST'] }), async (context, next) => {
		context.header('Cache-Control', 'private, max-age=0, must-revalidate');
		await next();
	});
	app.all(path, bodyLimit({
		maxSize: 1024 * 1024,
		// 未読の本文を残した接続を次のリクエストへ再利用しない。
		onError: context => context.body(null, 413, { Connection: 'close' }),
	}), handler);
}

/**
 * GETの拒否、JSON本文の解釈、トークンの抽出を行う。`Authorization: Bearer `（大文字小文字を区別）が
 * 本文の`i`より優先され、`i`は入力に残る。失敗時は空本文の応答を返す。
 */
export async function readApiRequest(context: Context): Promise<ApiRequest | Response> {
	if (context.req.method === 'GET') {
		return context.body(null, 405);
	}

	let input: unknown;
	try {
		const text = await context.req.text();
		input = text === '' ? undefined : JSON.parse(text);
	} catch {
		return context.body(null, 400);
	}

	const authorization = context.req.header('authorization');
	const bodyToken = input !== null && typeof input === 'object' ? (input as Record<string, unknown>).i : undefined;
	const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : bodyToken;
	// 本家は応答を送らずに接続を残すため、ここでは空の400で終える（承認済みの差異）。
	if (token != null && typeof token !== 'string') {
		return context.body(null, 400);
	}
	return { input, token };
}
