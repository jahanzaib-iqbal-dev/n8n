/* eslint-disable import-x/no-extraneous-dependencies -- test-only Vue mounting */
import type { AgentMemoryFactsResponse } from '@n8n/api-types';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentMemoryFactsMock = vi.fn();
const showErrorMock = vi.fn();

vi.mock('../composables/useAgentApi', () => ({
	getAgentMemoryFacts: (...args: unknown[]) => getAgentMemoryFactsMock(...args),
}));

vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({ restApiContext: { baseUrl: 'http://localhost:5678' } }),
}));

vi.mock('@/app/composables/useToast', () => ({
	useToast: () => ({ showError: showErrorMock }),
}));

vi.mock('@/app/utils/formatters/dateFormatter', () => ({
	convertToDisplayDate: () => ({ date: 'May 9, 2026', time: '10:00' }),
}));

vi.mock('@vue-flow/background', () => ({
	Background: {
		template: '<div data-test-id="canvas-background"></div>',
		props: ['patternColor', 'gap'],
	},
}));

vi.mock('@vue-flow/core', () => ({
	Handle: { template: '<span data-test-id="vue-flow-handle"></span>', props: ['type', 'position'] },
	Position: {
		Left: 'left',
		Right: 'right',
	},
	VueFlow: {
		template: `
			<div data-test-id="agent-memory-source-canvas">
				<slot />
				<div
					v-for="edge in edges"
					:key="edge.id"
					data-test-id="agent-memory-source-edge"
				>
					{{ edge.source }} {{ edge.target }} {{ edge.type }}
				</div>
				<div
					v-for="node in nodes"
					:key="node.id"
					data-test-id="vue-flow-node"
					:data-node-id="node.id"
					@click="$emit('node-click', { event: $event, node })"
				>
					<slot :name="'node-' + node.type" :data="node.data" />
				</div>
			</div>
		`,
		props: ['nodes', 'edges'],
		emits: ['node-click'],
	},
}));

vi.mock('@n8n/i18n', () => ({
	useI18n: () => ({
		baseText: (key: string, options?: { interpolate?: Record<string, string> }) => {
			if (key === 'agents.builder.memoryGraph.summary') {
				return `${options?.interpolate?.factCount} facts · ${options?.interpolate?.sourceCount} sources`;
			}

			const messages: Record<string, string> = {
				'agents.builder.memoryGraph.view.sourceGraph': 'Source graph',
				'agents.builder.memoryGraph.view.factList': 'Fact list',
				'agents.builder.memoryGraph.view.ariaLabel': 'Memory view',
				'agents.builder.memoryGraph.off.title': 'Cross-thread memory is off',
				'agents.builder.memoryGraph.off.description':
					'Existing facts remain visible, but new durable facts are not being stored.',
				'agents.builder.memoryGraph.loading': 'Loading memory facts...',
				'agents.builder.memoryGraph.loadError': 'Could not load memory facts',
				'agents.builder.memoryGraph.error': 'Memory facts could not be loaded.',
				'agents.builder.memoryGraph.empty.title': 'No remembered facts yet',
				'agents.builder.memoryGraph.empty.description':
					'Facts will appear here after this agent stores durable user memory.',
				'agents.builder.memoryGraph.inspector.title': 'Fact Details',
				'agents.builder.memoryGraph.factCard.created': 'Created',
				'agents.builder.memoryGraph.source.unknown': 'Unknown source',
				'agents.builder.memoryGraph.source.unknownSubtitle': 'No source thread',
				'agents.builder.memoryGraph.source.session': 'Session {sessionNumber}',
				'agents.builder.memoryGraph.notAvailable': 'Not available',
			};

			return (messages[key] ?? key).replace(
				/\{(\w+)\}/g,
				(_, name: string) => options?.interpolate?.[name] ?? `{${name}}`,
			);
		},
	}),
}));

vi.mock('@n8n/design-system', () => ({
	N8nBadge: { template: '<span data-test-id="n8n-badge"><slot /></span>' },
	N8nCallout: {
		inheritAttrs: false,
		template: '<div data-test-id="n8n-callout"><div v-bind="$attrs"><slot /></div></div>',
		props: ['theme', 'icon', 'slim'],
	},
	N8nDialog: {
		template: `
			<section v-if="open" data-test-id="agent-memory-fact-dialog">
				<header>{{ header }}</header>
				<button data-test-id="agent-memory-fact-dialog-close" type="button" @click="$emit('update:open', false)">Close</button>
				<slot />
			</section>
		`,
		props: ['open', 'header', 'size'],
		emits: ['update:open'],
	},
	N8nIcon: { template: '<i v-bind="$attrs"></i>', props: ['icon', 'size', 'spin'] },
	N8nRadioButtons: {
		template: `
			<div data-test-id="memory-view-radio-buttons">
				<button
					v-for="option in options"
					:key="option.value"
					data-test-id="memory-view-option"
					type="button"
					:disabled="option.disabled"
					@click="$emit('update:modelValue', option.value)"
				>
					{{ option.label }}
				</button>
			</div>
		`,
		props: ['modelValue', 'options', 'size'],
		emits: ['update:modelValue'],
	},
	N8nText: { template: '<span><slot /></span>', props: ['size', 'color', 'bold'] },
}));

function makeResponse(overrides: Partial<AgentMemoryFactsResponse> = {}): AgentMemoryFactsResponse {
	return {
		scope: { agentId: 'agent-1', resourceId: 'user-1' },
		sourceThreads: [
			{
				id: 'thread-1',
				title: 'Preferences',
				emoji: null,
				sessionNumber: 7,
				createdAt: '2026-05-09T10:00:00.000Z',
				updatedAt: '2026-05-09T10:05:00.000Z',
			},
			{
				id: 'thread-2',
				title: null,
				emoji: null,
				sessionNumber: 8,
				createdAt: '2026-05-09T11:00:00.000Z',
				updatedAt: '2026-05-09T11:05:00.000Z',
			},
		],
		facts: [
			{
				id: 'fact-1',
				content: 'The user prefers terse answers.',
				contentHash: 'abcdefghijklmnopqrstuvwxyz',
				createdAt: '2026-05-09T10:01:00.000Z',
				updatedAt: '2026-05-09T10:01:00.000Z',
				sourceThreadId: 'thread-1',
				sourceMessageId: 'message-1',
				embeddingModel: 'openai/text-embedding-3-small',
			},
			{
				id: 'fact-3',
				content: 'The user prefers OpenAI embeddings.',
				contentHash: 'hash-3',
				createdAt: '2026-05-09T11:02:00.000Z',
				updatedAt: '2026-05-09T11:02:00.000Z',
				sourceThreadId: 'thread-2',
				sourceMessageId: 'message-3',
				embeddingModel: 'openai/text-embedding-3-small',
			},
			{
				id: 'fact-2',
				content: 'The user works from Melbourne.',
				contentHash: 'hash-2',
				createdAt: '2026-05-09T10:02:00.000Z',
				updatedAt: '2026-05-09T10:02:00.000Z',
			},
		],
		...overrides,
	};
}

async function mountPanel({
	response = makeResponse(),
	crossThreadMemoryEnabled = true,
}: {
	response?: AgentMemoryFactsResponse;
	crossThreadMemoryEnabled?: boolean;
} = {}) {
	getAgentMemoryFactsMock.mockResolvedValueOnce(response);
	const { default: AgentMemoryGraphPanel } = await import(
		'../components/AgentMemoryGraphPanel.vue'
	);
	const wrapper = mount(AgentMemoryGraphPanel, {
		props: {
			projectId: 'project-1',
			agentId: 'agent-1',
			crossThreadMemoryEnabled,
		},
		global: {
			stubs: {
				RouterLink: {
					template: '<a data-test-id="source-thread-link"><slot /></a>',
					props: ['to'],
				},
			},
		},
	});
	await flushPromises();
	return wrapper;
}

describe('AgentMemoryGraphPanel', () => {
	beforeEach(() => {
		getAgentMemoryFactsMock.mockReset();
		showErrorMock.mockReset();
	});

	it('fetches facts and renders the source graph view by default', async () => {
		const wrapper = await mountPanel();

		expect(getAgentMemoryFactsMock).toHaveBeenCalledWith(
			{ baseUrl: 'http://localhost:5678' },
			'project-1',
			'agent-1',
		);
		expect(wrapper.find('[data-test-id="agent-memory-graph-summary"]').text()).toBe(
			'3 facts · 3 sources',
		);
		expect(wrapper.find('[data-test-id="memory-view-radio-buttons"]').exists()).toBe(true);
		expect(
			wrapper
				.findAll('[data-test-id="memory-view-option"]')
				.map((option) => [option.text(), option.attributes('disabled') !== undefined]),
		).toEqual([
			['Source graph', false],
			['Fact list', false],
		]);
		expect(wrapper.find('[data-test-id="memory-layer-radio-buttons"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Scope: current user');
		expect(wrapper.find('[data-test-id="agent-memory-source-graph"]').exists()).toBe(true);
		expect(wrapper.find('[data-test-id="agent-memory-fact-board"]').exists()).toBe(false);
		expect(wrapper.find('[data-test-id="agent-memory-source-cluster-thread-1"]').text()).toContain(
			'Preferences',
		);
		expect(wrapper.find('[data-test-id="agent-memory-source-cluster-thread-2"]').text()).toContain(
			'Session 8',
		);
		expect(
			wrapper.find('[data-test-id="agent-memory-source-cluster-unknown-source"]').text(),
		).toContain('Unknown source');
		expect(wrapper.find('[data-test-id="agent-memory-source-fact-fact-1"]').text()).toContain(
			'The user prefers terse answers.',
		);
		expect(wrapper.find('[data-test-id="agent-memory-source-fact-fact-1"] i').exists()).toBe(false);
		expect(wrapper.findAll('[data-test-id="agent-memory-source-edge"]').length).toBe(3);
		expect(wrapper.find('[data-test-id="agent-memory-source-edge"]').text()).toContain('straight');
		expect(wrapper.findAll('[data-test-id="vue-flow-handle"]').length).toBe(6);
		expect(
			wrapper.find('[data-test-id="agent-memory-source-cluster-thread-1"]').element.tagName,
		).toBe('DIV');
	});

	it('switches to the fact list view', async () => {
		const wrapper = await mountPanel();

		await wrapper.findAll('[data-test-id="memory-view-option"]')[1].trigger('click');

		expect(wrapper.find('[data-test-id="agent-memory-source-graph"]').exists()).toBe(false);
		expect(wrapper.find('[data-test-id="agent-memory-fact-board"]').exists()).toBe(true);
		expect(wrapper.find('[data-test-id="agent-memory-fact-card-fact-1"]').text()).toContain(
			'The user prefers terse answers.',
		);
		expect(wrapper.find('[data-test-id="agent-memory-fact-card-fact-1"]').text()).toContain(
			'Preferences',
		);
		expect(wrapper.find('[data-test-id="agent-memory-fact-card-fact-1"]').text()).toContain(
			'Session 7',
		);
	});

	it('renders the empty state when no facts exist', async () => {
		const wrapper = await mountPanel({ response: makeResponse({ facts: [], sourceThreads: [] }) });

		expect(wrapper.find('[data-test-id="agent-memory-graph-empty"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('No remembered facts yet');
	});

	it('renders the off state while still showing existing facts', async () => {
		const wrapper = await mountPanel({ crossThreadMemoryEnabled: false });

		expect(wrapper.find('[data-test-id="agent-memory-graph-off-state"]').exists()).toBe(true);
		expect(wrapper.find('[data-test-id="n8n-callout"]').exists()).toBe(true);
		expect(wrapper.find('[data-test-id="agent-memory-source-graph"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Cross-thread memory is off');
		expect(wrapper.text()).toContain('The user prefers terse answers.');
	});

	it('opens the fact detail modal from the source graph', async () => {
		const wrapper = await mountPanel();

		const factNode = wrapper
			.findAll('[data-test-id="vue-flow-node"]')
			.find((node) => node.attributes('data-node-id') === 'fact:fact-1');

		expect(factNode).toBeDefined();
		await factNode?.trigger('click');

		const detail = wrapper.find('[data-test-id="agent-memory-fact-dialog"]');
		expect(detail.exists()).toBe(true);
		expect(detail.find('header').text()).toBe('Fact Details');
		expect(detail.text()).toContain('The user prefers terse answers.');
		expect(detail.text()).toContain('May 9, 2026 10:00');
		expect(detail.text()).toContain('Preferences');
		expect(detail.text()).not.toContain('Updated');
		expect(detail.text()).not.toContain('Source');
		expect(detail.text()).not.toContain('Hash');
		expect(detail.text()).not.toContain('abcdefghijkl');
		expect(detail.text()).not.toContain('Created');
		expect(detail.text()).not.toContain('Session 7');
		expect(detail.text()).not.toContain('Embedding model');
		expect(wrapper.find('[data-test-id="source-thread-link"]').exists()).toBe(false);

		await wrapper.find('[data-test-id="agent-memory-fact-dialog-close"]').trigger('click');

		expect(wrapper.find('[data-test-id="agent-memory-fact-dialog"]').exists()).toBe(false);
		expect(
			wrapper.find('[data-test-id="agent-memory-source-fact-fact-1"]').classes(),
		).not.toContain('selectedFactCard');
	});

	it('opens the same fact detail modal from the fact list', async () => {
		const wrapper = await mountPanel();

		await wrapper.findAll('[data-test-id="memory-view-option"]')[1].trigger('click');
		await wrapper.find('[data-test-id="agent-memory-fact-card-fact-2"]').trigger('click');

		const detail = wrapper.find('[data-test-id="agent-memory-fact-dialog"]');
		expect(detail.text()).toContain('The user works from Melbourne.');
		expect(detail.text()).toContain('Unknown source');
		expect(wrapper.find('[data-test-id="source-thread-link"]').exists()).toBe(false);
	});

	it('uses the source title instead of the session number in fact details', async () => {
		const wrapper = await mountPanel();

		const factNode = wrapper
			.findAll('[data-test-id="vue-flow-node"]')
			.find((node) => node.attributes('data-node-id') === 'fact:fact-3');

		expect(factNode).toBeDefined();
		await factNode?.trigger('click');

		const detail = wrapper.find('[data-test-id="agent-memory-fact-dialog"]');
		expect(detail.text()).toContain('Not available');
		expect(detail.text()).not.toContain('Session 8');
	});
});
