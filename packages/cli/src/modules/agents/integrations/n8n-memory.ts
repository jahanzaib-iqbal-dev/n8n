import type {
	AgentDbMessage,
	AgentMessage,
	BuiltMemory,
	BuiltObservationStore,
	MemoryDescriptor,
	NewObservation,
	Observation,
	ObservationCursor,
	ObservationLockHandle,
	ScopeKind,
	Thread,
} from '@n8n/agents';
import { Service } from '@n8n/di';
import type { FindOptionsWhere } from '@n8n/typeorm';
import { Equal, In, LessThan, LessThanOrEqual, Like, MoreThan } from '@n8n/typeorm';
import type { QueryDeepPartialEntity } from '@n8n/typeorm/query-builder/QueryPartialEntity';
import { UnexpectedError } from 'n8n-workflow';

import { AgentMemoryFactEntity } from '../entities/agent-memory-fact.entity';
import type { AgentMessageEntity } from '../entities/agent-message.entity';
import { AgentObservationLockEntity } from '../entities/agent-observation-lock.entity';
import { AgentObservationEntity } from '../entities/agent-observation.entity';
import { AgentThreadEntity } from '../entities/agent-thread.entity';
import { AgentMessageRepository } from '../repositories/agent-message.repository';
import { AgentMemoryFactRepository } from '../repositories/agent-memory-fact.repository';
import { AgentObservationCursorRepository } from '../repositories/agent-observation-cursor.repository';
import { AgentObservationLockRepository } from '../repositories/agent-observation-lock.repository';
import { AgentObservationRepository } from '../repositories/agent-observation.repository';
import { AgentResourceRepository } from '../repositories/agent-resource.repository';
import { AgentThreadRepository } from '../repositories/agent-thread.repository';

/** Key inside the metadata JSON where working memory content is stored. */
const WORKING_MEMORY_KEY = 'workingMemory';
const CROSS_THREAD_RRF_K = 60;
const CROSS_THREAD_DEFAULT_TOP_K = 5;
const CROSS_THREAD_DEFAULT_HALF_LIFE_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface CrossThreadMemoryScope {
	agentId: string;
	resourceId: string;
}

interface CrossThreadFact {
	id: string;
	agentId: string;
	resourceId: string;
	content: string;
	contentHash: string;
	createdAt: Date;
	updatedAt: Date;
	sourceThreadId?: string;
	sourceMessageId?: string;
	embedding?: number[];
	embeddingModel?: string;
	metadata?: Record<string, unknown>;
}

type NewCrossThreadFact = Omit<CrossThreadFact, 'id' | 'updatedAt'>;

interface CrossThreadFactSearchOptions {
	topK?: number;
	halfLifeDays?: number;
	queryEmbedding?: number[];
}

interface RetrievedCrossThreadFact extends CrossThreadFact {
	lexicalScore: number;
	vectorScore: number;
	rrfScore: number;
	recencyFactor: number;
	finalScore: number;
}

@Service()
export class N8nMemory implements BuiltMemory, BuiltObservationStore {
	constructor(
		private readonly threadRepository: AgentThreadRepository,
		private readonly messageRepository: AgentMessageRepository,
		private readonly memoryFactRepository: AgentMemoryFactRepository,
		private readonly resourceRepository: AgentResourceRepository,
		private readonly observationRepository: AgentObservationRepository,
		private readonly observationCursorRepository: AgentObservationCursorRepository,
		private readonly observationLockRepository: AgentObservationLockRepository,
	) {}

	// ── Thread management ────────────────────────────────────────────────

	async getThread(threadId: string): Promise<Thread | null> {
		const entity = await this.threadRepository.findOneBy({ id: threadId });
		if (!entity) return null;
		return this.toThread(entity);
	}

	async saveThread(thread: Omit<Thread, 'createdAt' | 'updatedAt'>): Promise<Thread> {
		await this.ensureResource(thread.resourceId);

		const existing = await this.threadRepository.findOneBy({ id: thread.id });

		if (existing) {
			// `resourceId` is treated as immutable on existing threads. Some thread
			// IDs can receive messages from more than one resource; overwriting the
			// column on each save would make ownership depend on the last writer.
			// Per-user scoping is enforced at the message level via resourceId.
			if (thread.title !== undefined) existing.title = thread.title;
			if (thread.metadata !== undefined) {
				existing.metadata = thread.metadata ? JSON.stringify(thread.metadata) : null;
			}
			const saved = await this.threadRepository.save(existing);
			return this.toThread(saved);
		}

		const entity = this.threadRepository.create({
			id: thread.id,
			resourceId: thread.resourceId,
			title: thread.title ?? null,
			metadata: thread.metadata ? JSON.stringify(thread.metadata) : null,
		});
		const saved = await this.threadRepository.save(entity);
		return this.toThread(saved);
	}

	private async ensureResource(resourceId: string): Promise<void> {
		const exists = await this.resourceRepository.existsBy({ id: resourceId });
		if (!exists) {
			await this.resourceRepository.save(
				this.resourceRepository.create({ id: resourceId, metadata: null }),
			);
		}
	}

	async deleteThread(threadId: string): Promise<void> {
		await this.threadRepository.delete({ id: threadId });
	}

	async deleteThreadsByPrefix(threadIdPrefix: string): Promise<void> {
		await this.threadRepository.delete({ id: Like(`${threadIdPrefix}%`) });
	}

	// ── Message persistence ──────────────────────────────────────────────

	async getMessages(
		threadId: string,
		opts?: { limit?: number; before?: Date; resourceId?: string },
	): Promise<AgentDbMessage[]> {
		// `resourceId` is the per-user scope for any thread that carries messages
		// for more than one resource. Use an explicit `!== undefined` check — a
		// falsy (empty-string) value would otherwise drop the filter and leak other
		// users' messages.
		const where: FindOptionsWhere<AgentMessageEntity> = {
			threadId,
			...(opts?.before && { createdAt: LessThan(opts.before) }),
			...(opts?.resourceId !== undefined && { resourceId: opts.resourceId }),
		};

		const entities = await this.messageRepository.find({
			where,
			order: { createdAt: opts?.limit !== undefined ? 'DESC' : 'ASC' },
			...(opts?.limit !== undefined && { take: opts.limit }),
		});
		if (opts?.limit !== undefined) {
			entities.reverse();
		}

		return entities.map((e) => this.toAgentDbMessage(e));
	}

	async saveMessages(args: {
		threadId: string;
		resourceId: string;
		messages: AgentDbMessage[];
	}): Promise<void> {
		if (args.messages.length === 0) return;

		// Upsert by id — bulk INSERT … ON CONFLICT (id) DO UPDATE avoids the
		// per-row SELECT that save() performs. createdAt is passed explicitly so
		// the column is preserved on conflict; updatedAt is set manually because
		// the @BeforeUpdate hook does not fire during upsert.
		const now = new Date();
		const entities = args.messages.map((dbMsg) => {
			const role = 'role' in dbMsg ? (dbMsg.role as string) : 'custom';
			const type = 'type' in dbMsg ? (dbMsg.type as string) : null;
			return {
				id: dbMsg.id,
				threadId: args.threadId,
				resourceId: args.resourceId,
				role,
				type: type ?? null,
				content: dbMsg as unknown as Record<string, unknown>,
				createdAt: dbMsg.createdAt,
				updatedAt: now,
			} as QueryDeepPartialEntity<AgentMessageEntity>;
		});

		await this.messageRepository.upsert(entities, ['id']);
	}

	async deleteMessages(messageIds: string[]): Promise<void> {
		if (messageIds.length === 0) return;
		await this.messageRepository.delete(messageIds);
	}

	async deleteMessagesByThread(threadId: string, resourceId?: string): Promise<void> {
		// Mirrors `getMessages`: explicit `!== undefined` check so that a falsy
		// (empty-string) `resourceId` cannot accidentally delete every user's
		// messages on a shared thread.
		await this.messageRepository.delete({
			threadId,
			...(resourceId !== undefined && { resourceId }),
		});
	}

	// ── Cross-thread facts ───────────────────────────────────────────────

	async saveCrossThreadFacts(facts: NewCrossThreadFact[]): Promise<CrossThreadFact[]> {
		const saved: CrossThreadFact[] = [];

		for (const fact of facts) {
			const existing = await this.memoryFactRepository.findOneBy({
				agentId: fact.agentId,
				resourceId: fact.resourceId,
				contentHash: fact.contentHash,
			});
			if (existing) {
				saved.push(this.toCrossThreadFact(existing));
				continue;
			}

			const entity = this.memoryFactRepository.create({
				agentId: fact.agentId,
				resourceId: fact.resourceId,
				content: fact.content,
				contentHash: fact.contentHash,
				sourceThreadId: fact.sourceThreadId ?? null,
				sourceMessageId: fact.sourceMessageId ?? null,
				embeddingModel: fact.embeddingModel ?? null,
				embedding: fact.embedding ?? null,
				metadata: fact.metadata ?? null,
				createdAt: fact.createdAt,
			});
			const persisted = await this.memoryFactRepository.save(entity);
			saved.push(this.toCrossThreadFact(persisted));
		}

		return saved;
	}

	async searchCrossThreadFacts(
		scope: CrossThreadMemoryScope,
		query: string,
		opts?: CrossThreadFactSearchOptions,
	): Promise<RetrievedCrossThreadFact[]> {
		const entities = await this.memoryFactRepository.find({
			where: { agentId: scope.agentId, resourceId: scope.resourceId },
		});

		return rankCrossThreadFacts(
			entities.map((entity) => this.toCrossThreadFact(entity)),
			query,
			opts,
		);
	}

	// ── Working memory ───────────────────────────────────────────────────

	async getWorkingMemory(params: {
		threadId: string;
		resourceId: string;
		scope: 'resource' | 'thread';
	}): Promise<string | null> {
		if (params.scope === 'resource') {
			const resource = await this.resourceRepository.findOneBy({ id: params.resourceId });
			return this.extractWorkingMemory(resource?.metadata ?? null);
		}

		const thread = await this.threadRepository.findOneBy({ id: params.threadId });
		return this.extractWorkingMemory(thread?.metadata ?? null);
	}

	async saveWorkingMemory(
		params: { threadId: string; resourceId: string; scope: 'resource' | 'thread' },
		content: string,
	): Promise<void> {
		if (params.scope === 'resource') {
			await this.upsertResourceMetadata(params.resourceId, content);
		} else {
			await this.upsertThreadMetadata(params.threadId, params.resourceId, content);
		}
	}

	// ── Observational memory: data ───────────────────────────────────────

	async appendObservations(rows: NewObservation[]): Promise<Observation[]> {
		if (rows.length === 0) return [];

		const entities: AgentObservationEntity[] = rows.map((row) =>
			this.observationRepository.create({
				scopeKind: row.scopeKind,
				scopeId: row.scopeId,
				kind: row.kind,
				payload: row.payload,
				durationMs: row.durationMs,
				schemaVersion: row.schemaVersion,
				createdAt: row.createdAt,
			}),
		);

		const saved = await this.observationRepository.save(entities);
		return saved.map((e) => this.toObservation(e));
	}

	async getObservations(opts: {
		scopeKind: ScopeKind;
		scopeId: string;
		since?: { sinceCreatedAt: Date; sinceObservationId: string };
		kindIs?: string;
		limit?: number;
		schemaVersionAtMost?: number;
	}): Promise<Observation[]> {
		const baseWhere: FindOptionsWhere<AgentObservationEntity> = {
			scopeKind: opts.scopeKind,
			scopeId: opts.scopeId,
			...(opts.kindIs !== undefined && { kind: opts.kindIs }),
			...(opts.schemaVersionAtMost !== undefined && {
				schemaVersion: LessThanOrEqual(opts.schemaVersionAtMost),
			}),
		};
		const where: FindOptionsWhere<AgentObservationEntity>[] = opts.since
			? [
					{ ...baseWhere, createdAt: MoreThan(opts.since.sinceCreatedAt) },
					{
						...baseWhere,
						createdAt: Equal(opts.since.sinceCreatedAt),
						id: MoreThan(opts.since.sinceObservationId),
					},
				]
			: [baseWhere];
		const entities = await this.observationRepository.find({
			where,
			order: { createdAt: 'ASC', id: 'ASC' },
			...(opts.limit !== undefined && { take: opts.limit }),
		});
		return entities.map((e) => this.toObservation(e));
	}

	async getMessagesForScope(
		scopeKind: ScopeKind,
		scopeId: string,
		opts?: { since?: { sinceCreatedAt: Date; sinceMessageId: string } },
	): Promise<AgentDbMessage[]> {
		if (scopeKind !== 'thread') {
			throw new UnexpectedError(
				`getMessagesForScope: scopeKind='${scopeKind}' is not supported in observational memory v1`,
			);
		}

		const baseWhere: FindOptionsWhere<AgentMessageEntity> = { threadId: scopeId };
		const where: FindOptionsWhere<AgentMessageEntity>[] = opts?.since
			? [
					{ ...baseWhere, createdAt: MoreThan(opts.since.sinceCreatedAt) },
					{
						...baseWhere,
						createdAt: Equal(opts.since.sinceCreatedAt),
						id: MoreThan(opts.since.sinceMessageId),
					},
				]
			: [baseWhere];

		const entities = await this.messageRepository.find({
			where,
			order: { createdAt: 'ASC', id: 'ASC' },
		});
		return entities.map((e) => this.toAgentDbMessage(e));
	}

	async deleteObservations(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.observationRepository.delete({ id: In(ids) });
	}

	// ── Observational memory: cursors ────────────────────────────────────

	async getCursor(scopeKind: ScopeKind, scopeId: string): Promise<ObservationCursor | null> {
		const entity = await this.observationCursorRepository.findOneBy({ scopeKind, scopeId });
		if (!entity) return null;
		return {
			scopeKind: entity.scopeKind,
			scopeId: entity.scopeId,
			lastObservedMessageId: entity.lastObservedMessageId,
			lastObservedAt: entity.lastObservedAt,
			updatedAt: entity.updatedAt,
		};
	}

	async setCursor(cursor: ObservationCursor): Promise<void> {
		await this.observationCursorRepository.upsert(
			{
				scopeKind: cursor.scopeKind,
				scopeId: cursor.scopeId,
				lastObservedMessageId: cursor.lastObservedMessageId,
				lastObservedAt: cursor.lastObservedAt,
				updatedAt: cursor.updatedAt,
			},
			{ conflictPaths: ['scopeKind', 'scopeId'], skipUpdateIfNoValuesChanged: false },
		);
	}

	// ── Observational memory: locks ──────────────────────────────────────

	async acquireObservationLock(
		scopeKind: ScopeKind,
		scopeId: string,
		opts: { ttlMs: number; holderId: string },
	): Promise<ObservationLockHandle | null> {
		const now = new Date();
		const heldUntil = new Date(now.getTime() + opts.ttlMs);

		const updateResult = await this.observationLockRepository
			.createQueryBuilder()
			.update(AgentObservationLockEntity)
			.set({ holderId: opts.holderId, heldUntil })
			.where('"scopeKind" = :scopeKind')
			.andWhere('"scopeId" = :scopeId')
			.andWhere('("holderId" = :holderId OR "heldUntil" <= :now)')
			.setParameters({ scopeKind, scopeId, holderId: opts.holderId, now })
			.execute();

		if ((updateResult.affected ?? 0) > 0) {
			return { scopeKind, scopeId, holderId: opts.holderId, heldUntil };
		}

		await this.observationLockRepository
			.createQueryBuilder()
			.insert()
			.into(AgentObservationLockEntity)
			.values({ scopeKind, scopeId, holderId: opts.holderId, heldUntil })
			.orIgnore()
			.execute();

		const claimed = await this.observationLockRepository.findOneBy({
			scopeKind,
			scopeId,
			holderId: opts.holderId,
		});
		if (!claimed) return null;

		return { scopeKind, scopeId, holderId: opts.holderId, heldUntil };
	}

	async releaseObservationLock(handle: ObservationLockHandle): Promise<void> {
		await this.observationLockRepository.delete({
			scopeKind: handle.scopeKind,
			scopeId: handle.scopeId,
			holderId: handle.holderId,
		});
	}

	// ── Descriptor ───────────────────────────────────────────────────────

	describe(): MemoryDescriptor {
		return { name: 'n8n', connectionParams: {}, constructorName: this.constructor.name };
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	private toAgentDbMessage(entity: AgentMessageEntity): AgentDbMessage {
		const msg = entity.content as AgentMessage & { id?: string; createdAt?: Date };
		msg.id = entity.id;
		msg.createdAt = entity.createdAt;
		return msg as AgentDbMessage;
	}

	private toObservation(entity: AgentObservationEntity): Observation {
		return {
			id: entity.id,
			scopeKind: entity.scopeKind,
			scopeId: entity.scopeId,
			kind: entity.kind,
			payload: entity.payload as Observation['payload'],
			durationMs: entity.durationMs === null ? null : Number(entity.durationMs),
			schemaVersion: Number(entity.schemaVersion),
			createdAt: entity.createdAt,
		};
	}

	private toCrossThreadFact(entity: AgentMemoryFactEntity): CrossThreadFact {
		return {
			id: entity.id,
			agentId: entity.agentId,
			resourceId: entity.resourceId,
			content: entity.content,
			contentHash: entity.contentHash,
			createdAt: entity.createdAt,
			updatedAt: entity.updatedAt,
			...(entity.sourceThreadId !== null && { sourceThreadId: entity.sourceThreadId }),
			...(entity.sourceMessageId !== null && { sourceMessageId: entity.sourceMessageId }),
			...(entity.embedding !== null && { embedding: entity.embedding }),
			...(entity.embeddingModel !== null && { embeddingModel: entity.embeddingModel }),
			...(entity.metadata !== null && { metadata: entity.metadata }),
		};
	}

	private toThread(entity: AgentThreadEntity): Thread {
		let metadata: Record<string, unknown> | undefined;
		if (entity.metadata) {
			try {
				metadata = JSON.parse(entity.metadata) as Record<string, unknown>;
			} catch {
				metadata = undefined;
			}
		}
		return {
			id: entity.id,
			resourceId: entity.resourceId,
			title: entity.title ?? undefined,
			metadata,
			createdAt: entity.createdAt,
			updatedAt: entity.updatedAt,
		};
	}

	private extractWorkingMemory(metadataJson: string | null): string | null {
		if (!metadataJson) return null;
		try {
			const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
			const wm = parsed[WORKING_MEMORY_KEY];
			return typeof wm === 'string' ? wm : null;
		} catch {
			return null;
		}
	}

	private mergeWorkingMemory(existingJson: string | null, content: string): string {
		let parsed: Record<string, unknown> = {};
		if (existingJson) {
			try {
				parsed = JSON.parse(existingJson) as Record<string, unknown>;
			} catch {
				// start fresh on corrupt JSON
			}
		}
		parsed[WORKING_MEMORY_KEY] = content;
		return JSON.stringify(parsed);
	}

	private async upsertResourceMetadata(resourceId: string, content: string): Promise<void> {
		const existing = await this.resourceRepository.findOneBy({ id: resourceId });
		if (existing) {
			existing.metadata = this.mergeWorkingMemory(existing.metadata, content);
			await this.resourceRepository.save(existing);
		} else {
			const entity = this.resourceRepository.create({
				id: resourceId,
				metadata: this.mergeWorkingMemory(null, content),
			});
			await this.resourceRepository.save(entity);
		}
	}

	private async upsertThreadMetadata(
		threadId: string,
		resourceId: string,
		content: string,
	): Promise<void> {
		const existing = await this.threadRepository.findOneBy({ id: threadId });
		if (existing) {
			existing.metadata = this.mergeWorkingMemory(existing.metadata, content);
			await this.threadRepository.save(existing);
			return;
		}

		await this.ensureResource(resourceId);
		await this.threadRepository.save(
			this.threadRepository.create({
				id: threadId,
				resourceId,
				title: null,
				metadata: this.mergeWorkingMemory(null, content),
			}),
		);
	}
}

function rankCrossThreadFacts(
	facts: CrossThreadFact[],
	query: string,
	opts: CrossThreadFactSearchOptions = {},
): RetrievedCrossThreadFact[] {
	const topK = opts.topK ?? CROSS_THREAD_DEFAULT_TOP_K;
	const queryTokens = tokenize(query);
	const lexical = facts
		.map((fact) => ({ fact, score: lexicalScore(queryTokens, tokenize(fact.content)) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score);
	const vector = facts
		.map((fact) => ({
			fact,
			score:
				opts.queryEmbedding && fact.embedding
					? cosineSimilarity(opts.queryEmbedding, fact.embedding)
					: 0,
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score);

	const scores = new Map<
		string,
		{
			fact: CrossThreadFact;
			lexicalScore: number;
			vectorScore: number;
			rrfScore: number;
		}
	>();
	for (const fact of facts) {
		scores.set(fact.id, { fact, lexicalScore: 0, vectorScore: 0, rrfScore: 0 });
	}

	for (let rank = 0; rank < lexical.length; rank++) {
		const entry = scores.get(lexical[rank].fact.id);
		if (!entry) continue;
		entry.lexicalScore = lexical[rank].score;
		entry.rrfScore += 1 / (CROSS_THREAD_RRF_K + rank + 1);
	}

	for (let rank = 0; rank < vector.length; rank++) {
		const entry = scores.get(vector[rank].fact.id);
		if (!entry) continue;
		entry.vectorScore = vector[rank].score;
		entry.rrfScore += 1 / (CROSS_THREAD_RRF_K + rank + 1);
	}

	return [...scores.values()]
		.map((entry) => {
			const recencyFactor = computeRecencyFactor(entry.fact.createdAt, opts.halfLifeDays);
			const fallbackScore = entry.rrfScore > 0 ? entry.rrfScore : recencyFactor * 0.0001;
			return {
				...entry.fact,
				lexicalScore: entry.lexicalScore,
				vectorScore: entry.vectorScore,
				rrfScore: entry.rrfScore,
				recencyFactor,
				finalScore: fallbackScore * recencyFactor,
			};
		})
		.sort((a, b) => b.finalScore - a.finalScore)
		.slice(0, topK);
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 1);
}

function lexicalScore(queryTokens: string[], contentTokens: string[]): number {
	if (queryTokens.length === 0 || contentTokens.length === 0) return 0;
	const contentCounts = new Map<string, number>();
	for (const token of contentTokens) {
		contentCounts.set(token, (contentCounts.get(token) ?? 0) + 1);
	}

	let score = 0;
	for (const token of queryTokens) {
		score += contentCounts.get(token) ?? 0;
	}

	return score / Math.sqrt(contentTokens.length);
}

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let aMagnitude = 0;
	let bMagnitude = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		aMagnitude += a[i] * a[i];
		bMagnitude += b[i] * b[i];
	}
	if (aMagnitude === 0 || bMagnitude === 0) return 0;
	return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function computeRecencyFactor(
	createdAt: Date,
	halfLifeDays = CROSS_THREAD_DEFAULT_HALF_LIFE_DAYS,
): number {
	if (halfLifeDays <= 0) return 1;
	const ageDays = Math.max(0, Date.now() - createdAt.getTime()) / MS_PER_DAY;
	return Math.pow(0.5, ageDays / halfLifeDays);
}
