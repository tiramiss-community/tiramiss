/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { RoleCacheConfig } from '../config/types.js';
import type { RoleFactsReader } from '../modules/role/public.js';

export type RoleMaterialReader = Pick<RoleFactsReader, 'readRoles' | 'readAssignments'>;

interface Entry<T> {
	expiresAt: number;
	promise: Promise<T>;
}

class MaterialCache<T> {
	private readonly entries = new Map<string, Entry<T>>();

	constructor(private readonly ttlMs: number, private readonly maxEntries: number, private readonly clock: () => number) {}

	async read(key: string, load: () => Promise<T>): Promise<T> {
		let entry = this.entries.get(key);
		if (entry && this.clock() >= entry.expiresAt) {
			this.entries.delete(key);
			entry = undefined;
		}
		if (!entry) {
			const created: Entry<T> = {
				expiresAt: this.clock() + this.ttlMs,
				promise: Promise.resolve().then(load).then(value => structuredClone(value)).catch((error: unknown) => {
					if (this.entries.get(key) === created) {
						this.entries.delete(key);
					}
					throw error;
				}),
			};
			entry = created;
		}
		// Mapの順序だけをLRUに用いる。エントリの期限は参照で延長しない。
		this.entries.delete(key);
		this.entries.set(key, entry);
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) {
				this.entries.delete(oldest);
			}
		}
		return structuredClone(await entry.promise);
	}

	clear(): void {
		this.entries.clear();
	}
}

export class RoleMaterialCache implements RoleMaterialReader {
	private readonly roles: MaterialCache<Awaited<ReturnType<RoleMaterialReader['readRoles']>>>;
	private readonly assignments: MaterialCache<Awaited<ReturnType<RoleMaterialReader['readAssignments']>>>;

	constructor(private readonly source: RoleMaterialReader, config: RoleCacheConfig, clock = () => performance.now()) {
		for (const value of Object.values(config)) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new Error('Role cache limits must be positive safe integers');
			}
		}
		this.roles = new MaterialCache(config.rolesTtlMs, 1, clock);
		this.assignments = new MaterialCache(config.assignmentsTtlMs, config.assignmentsMaxEntries, clock);
	}

	readRoles() {
		return this.roles.read('roles', () => this.source.readRoles());
	}

	readAssignments(userId: string) {
		return this.assignments.read(userId, () => this.source.readAssignments(userId));
	}

	invalidateRoles(): void {
		this.roles.clear();
	}

	clear(): void {
		this.roles.clear();
		this.assignments.clear();
	}
}
