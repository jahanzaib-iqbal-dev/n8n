import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AgentMemoryFactEntity } from '../entities/agent-memory-fact.entity';

@Service()
export class AgentMemoryFactRepository extends Repository<AgentMemoryFactEntity> {
	constructor(dataSource: DataSource) {
		super(AgentMemoryFactEntity, dataSource.manager);
	}
}
