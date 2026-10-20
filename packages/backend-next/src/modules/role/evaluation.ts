/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EvaluationRole, InstanceRoleFacts, RoleAssignment, RolePrivileges, UserRoleFacts } from './model.js';
import type { RolePolicies } from './policy-defaults.js';
import { selectApplicableRoles } from './applicable-roles.js';
import { EvaluationClosed, EvaluationMemo } from './evaluation-memo.js';
import { evaluatePolicies } from './policies.js';
import { evaluatePrivileges } from './privileges.js';

export interface RoleFactsReader {
	readRoles(): Promise<readonly EvaluationRole[]>;
	readAssignments(userId: string): Promise<readonly RoleAssignment[]>;
	readUserRoleFacts(userId: string): Promise<UserRoleFacts>;
	readInstanceRoleFacts(): Promise<InstanceRoleFacts>;
}

export type RoleFactsChange =
	| { kind: 'roles' }
	| { kind: 'instance' }
	| { kind: 'assignments'; userId: string }
	| { kind: 'user'; userId: string };

export interface RoleEvaluationSession {
	getEffectivePolicies(userId: string | null): Promise<RolePolicies>;
	getPrivileges(userId: string | null): Promise<RolePrivileges>;
	close(): void;
}

export interface RoleEvaluation {
	readonly atMs: number;
	openSession(reader: RoleFactsReader, uploadLimitBytes: number): RoleEvaluationSession;
	invalidate(change: RoleFactsChange): void;
	close(): void;
}

export function createRequestEvaluation(clock: () => number): RoleEvaluation {
	return new EvaluationBoundary(clock);
}

export function createAttemptEvaluation(startedAtMs: number): RoleEvaluation {
	return new EvaluationBoundary(() => startedAtMs);
}

function key(kind: string, userId: string | null): string {
	return JSON.stringify([kind, userId]);
}

class EvaluationBoundary implements RoleEvaluation {
	private referenceTimeMs: number | undefined;
	private closed = false;
	private readonly sessions = new Set<ReferenceSession>();

	constructor(private readonly clock: () => number) {}

	get atMs(): number {
		return this.time();
	}

	openSession(reader: RoleFactsReader, uploadLimitBytes: number): RoleEvaluationSession {
		this.assertOpen();
		const session = new ReferenceSession(reader, uploadLimitBytes, () => this.time(), () => this.sessions.delete(session));
		this.sessions.add(session);
		return session;
	}

	invalidate(change: RoleFactsChange): void {
		this.assertOpen();
		const dependency = 'userId' in change ? key(change.kind, change.userId) : change.kind;
		for (const session of this.sessions) {
			session.invalidate(dependency);
		}
	}

	close(): void {
		this.closed = true;
		for (const session of this.sessions) {
			session.close();
		}
		this.sessions.clear();
	}

	private time(): number {
		this.assertOpen();
		this.referenceTimeMs ??= this.clock();
		return this.referenceTimeMs;
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new EvaluationClosed('The evaluation boundary has ended');
		}
	}
}

class ReferenceSession implements RoleEvaluationSession {
	private readonly memo = new EvaluationMemo();

	constructor(
		private readonly reader: RoleFactsReader,
		private readonly uploadLimitBytes: number,
		private readonly time: () => number,
		private readonly onClose: () => void,
	) {}

	async getEffectivePolicies(userId: string | null): Promise<RolePolicies> {
		this.memo.assertOpen();
		const atMs = this.time();
		const dependencies = userId === null ? ['instance'] : ['instance', ...this.userDependencies(userId)];
		return this.memo.get(key('policies', userId), dependencies, async () => {
			const [instance, roles] = await Promise.all([
				this.instance(), userId === null ? [] : this.applicableRoles(userId, atMs),
			]);
			return evaluatePolicies({ userId, roles, basePolicies: instance.basePolicies, uploadLimitBytes: this.uploadLimitBytes });
		});
	}

	async getPrivileges(userId: string | null): Promise<RolePrivileges> {
		this.memo.assertOpen();
		const atMs = this.time();
		const dependencies = userId === null ? [] : ['instance', ...this.userDependencies(userId)];
		return this.memo.get(key('privileges', userId), dependencies, async () => {
			if (userId === null) {
				return evaluatePrivileges(null, null, []);
			}
			const instance = await this.instance();
			const roles = userId === instance.rootUserId ? [] : await this.applicableRoles(userId, atMs);
			return evaluatePrivileges(userId, instance.rootUserId, roles);
		});
	}

	invalidate(dependency: string): void {
		this.memo.invalidate([dependency]);
	}

	close(): void {
		this.memo.close();
		this.onClose();
	}

	private userDependencies(userId: string): string[] {
		return ['roles', key('assignments', userId), key('user', userId)];
	}

	private instance(): Promise<InstanceRoleFacts> {
		return this.memo.get('instance', ['instance'], () => this.reader.readInstanceRoleFacts());
	}

	private applicableRoles(userId: string, atMs: number): Promise<readonly EvaluationRole[]> {
		return this.memo.get(key('applicable', userId), this.userDependencies(userId), async () => {
			const [roles, assignments, user] = await Promise.all([
				this.memo.get('roles', ['roles'], () => this.reader.readRoles()),
				this.memo.get(key('assignments', userId), [key('assignments', userId)], () => this.reader.readAssignments(userId)),
				this.memo.get(key('user', userId), [key('user', userId)], () => this.reader.readUserRoleFacts(userId)),
			]);
			return selectApplicableRoles(roles, assignments, user, atMs);
		});
	}
}
