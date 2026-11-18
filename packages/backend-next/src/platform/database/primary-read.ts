/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { EntityManager, SelectQueryBuilder } from 'typeorm';
import type { DataSource, EntityTarget, ObjectLiteral, QueryRunner } from 'typeorm';

class PrimarySelectQueryBuilder<Entity extends ObjectLiteral> extends SelectQueryBuilder<Entity> {
	protected override obtainQueryRunner(): QueryRunner {
		return this.queryRunner ?? this.dataSource.createQueryRunner('master');
	}
}

class PrimaryReadManager extends EntityManager {
	override createQueryBuilder<Entity extends ObjectLiteral>(entity: EntityTarget<Entity>, alias: string, runner?: QueryRunner): SelectQueryBuilder<Entity>;
	override createQueryBuilder(runner?: QueryRunner): SelectQueryBuilder<ObjectLiteral>;
	override createQueryBuilder<Entity extends ObjectLiteral>(entityOrRunner?: EntityTarget<Entity> | QueryRunner, alias?: string, runner?: QueryRunner): SelectQueryBuilder<Entity> {
		const query = alias
			? super.createQueryBuilder(entityOrRunner as EntityTarget<Entity>, alias, runner)
			: super.createQueryBuilder(entityOrRunner as QueryRunner | undefined);
		// Without an explicit runner, TypeORM owns and releases each SELECT's runner itself.
		return new PrimarySelectQueryBuilder<Entity>(query);
	}
}

export async function readFromPrimary<T>(source: DataSource, read: (manager: EntityManager) => Promise<T>): Promise<T> {
	return read(source.driver.isReplicated ? new PrimaryReadManager(source) : source.manager);
}
