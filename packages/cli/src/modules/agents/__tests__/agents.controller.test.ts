import { ControllerRegistryMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { mock } from 'jest-mock-extended';

import type { CredentialsService } from '@/credentials/credentials.service';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import type { AgentExecutionService } from '../agent-execution.service';
import { AgentsController } from '../agents.controller';
import type { AgentsService } from '../agents.service';
import type { AgentsBuilderService } from '../builder/agents-builder.service';
import type { ChatIntegrationService } from '../integrations/chat-integration.service';
import type { AgentScheduleService } from '../integrations/agent-schedule.service';
import type { AgentRepository } from '../repositories/agent.repository';

// The webhook route is the single exception: it is `skipAuth: true` (no
// req.user) and authenticates inbound third-party callbacks via per-platform
// signature verification inside the handler.
const UNAUTHENTICATED_HANDLERS = new Set(['handleWebhook']);

const metadata = Container.get(ControllerRegistryMetadata).getControllerMetadata(
	AgentsController as never,
);

const routeCases = Array.from(metadata.routes.entries()).map(([handlerName, route]) => ({
	handlerName,
	route,
}));

describe('AgentsController route access scopes', () => {
	it.each(routeCases)(
		'$handlerName is gated by a project-scoped agent:* check',
		({ handlerName, route }) => {
			if (UNAUTHENTICATED_HANDLERS.has(handlerName)) {
				expect(route.accessScope).toBeUndefined();
				expect(route.skipAuth).toBe(true);
				return;
			}

			expect(route.accessScope).toBeDefined();
			expect(route.accessScope?.globalOnly).toBe(false);
			expect(route.accessScope?.scope.startsWith('agent:')).toBe(true);
		},
	);

	it.each([
		['listSkills', 'agent:read'],
		['getSkill', 'agent:read'],
		['createSkill', 'agent:update'],
		['updateSkill', 'agent:update'],
		['deleteSkill', 'agent:update'],
		['revertToPublished', 'agent:update'],
		['getMemoryFacts', 'agent:read'],
	])('%s uses %s', (handlerName, scope) => {
		expect(metadata.routes.get(handlerName)?.accessScope?.scope).toBe(scope);
	});
});

describe('AgentsController memory facts', () => {
	function makeController(agentsService = mock<AgentsService>()) {
		return {
			agentsService,
			controller: new AgentsController(
				agentsService,
				mock<AgentsBuilderService>(),
				mock<CredentialsService>(),
				mock<ChatIntegrationService>(),
				mock<AgentScheduleService>(),
				mock<AgentRepository>(),
				mock<AgentExecutionService>(),
			),
		};
	}

	it('uses the authenticated user id as the memory resource scope', async () => {
		const { controller, agentsService } = makeController();
		const response = {
			scope: { agentId: 'agent-1', resourceId: 'user-1' },
			facts: [],
			sourceThreads: [],
		};
		agentsService.getMemoryFacts.mockResolvedValue(response);

		const result = await controller.getMemoryFacts({
			params: { projectId: 'project-1', agentId: 'agent-1' },
			user: { id: 'user-1' },
		} as never);

		expect(agentsService.getMemoryFacts).toHaveBeenCalledWith('project-1', 'agent-1', 'user-1');
		expect(result).toBe(response);
	});

	it('returns not found when the agent is outside the project', async () => {
		const { controller, agentsService } = makeController();
		agentsService.getMemoryFacts.mockResolvedValue(null);

		await expect(
			controller.getMemoryFacts({
				params: { projectId: 'project-1', agentId: 'agent-1' },
				user: { id: 'user-1' },
			} as never),
		).rejects.toThrow(NotFoundError);
	});
});
