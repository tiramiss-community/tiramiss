/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export function createPostingStream(redis: { publish(channel: string, value: string): Promise<number> }, selfUrl: string) {
	const host = new URL(selfUrl).host;
	const publish = async (channel: string, message: unknown): Promise<void> => {
		await redis.publish(host, JSON.stringify({ channel, message }));
	};
	return {
		notes: (note: Record<string, unknown>) => publish('notesStream', note),
		role: (roleId: string, note: Record<string, unknown>) => publish(`roleTimelineStream:${roleId}`, { type: 'note', body: note }),
		main: (userId: string, type: string, body: unknown = null) => publish(`mainStream:${userId}`, { type, body }),
		deleted: (note: { id: string; userId: string; visibility: string; visibleUserIds: string[] }, deletedAt: number) => publish(`noteStream:${note.id}`, {
			type: 'deleted', body: { id: note.id, userId: note.userId, visibility: note.visibility, visibleUserIds: note.visibleUserIds, body: { deletedAt: new Date(deletedAt).toISOString() } },
		}),
	};
}
