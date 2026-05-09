/* eslint-disable import-x/no-extraneous-dependencies -- test-only Vue mounting */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';

vi.mock('@n8n/i18n', () => ({
	useI18n: () => ({
		baseText: (key: string) =>
			({
				'agents.builder.memory.title': 'Session Memory',
				'agents.builder.memory.description':
					'Keeps recent messages from this session available as context.',
				'agents.builder.editorColumn.ariaLabel': 'Agent editor',
				'agents.builder.header.tab.memory': 'Memory',
				'agents.builder.memoryGraph.description': 'Inspect memory facts.',
			})[key] ?? key,
	}),
}));

vi.mock('@n8n/design-system', () => ({
	N8nCard: { template: '<div><slot /></div>', props: ['variant'] },
	N8nHeading: { template: '<h2><slot /></h2>', props: ['size'] },
	N8nRadioButtons: { template: '<div />', props: ['modelValue', 'options'] },
	N8nSwitch: { template: '<button data-test-id="agent-memory-toggle"></button>' },
	N8nText: { template: '<span><slot /></span>', props: ['tag', 'bold', 'size', 'color'] },
}));

async function mountColumn(overrides: { activeMainTab?: 'agent' | 'memory' } = {}) {
	const { default: AgentBuilderEditorColumn } = await import(
		'../components/AgentBuilderEditorColumn.vue'
	);
	return mount(AgentBuilderEditorColumn, {
		props: {
			activeMainTab: overrides.activeMainTab ?? 'agent',
			mainTabOptions: [
				{ label: 'Agent', value: 'agent' },
				{ label: 'Memory', value: 'memory' },
			],
			localConfig: {
				name: 'Agent',
				model: 'anthropic/claude-sonnet-4-5',
				instructions: 'Help the user.',
				memory: { enabled: true, storage: 'n8n', lastMessages: 10 },
			},
			agent: null,
			projectId: 'project-1',
			agentId: 'agent-1',
			appliedSkills: [],
			connectedTriggers: [],
			isBuildChatStreaming: false,
			executionsDescription: '',
		},
		global: {
			stubs: {
				AgentCapabilitiesSection: true,
				AgentIdentityHeader: true,
				AgentInfoPanel: true,
				AgentPanelHeader: true,
				AgentAdvancedPanel: true,
				AgentSessionsListView: true,
				AgentMemoryGraphPanel: {
					template: '<div data-test-id="stub-memory-graph" />',
					props: ['projectId', 'agentId', 'crossThreadMemoryEnabled'],
				},
			},
		},
	});
}

describe('AgentBuilderEditorColumn', () => {
	it('renders only the session memory row in the builder memory card', async () => {
		const wrapper = await mountColumn();

		expect(wrapper.text()).toContain('Session Memory');
		expect(wrapper.text()).toContain(
			'Keeps recent messages from this session available as context.',
		);
		expect(wrapper.text()).not.toContain('Automatic memory');
		expect(wrapper.find('[data-test-id="agent-observational-memory-toggle"]').exists()).toBe(false);
	});

	it('renders the memory graph panel in the Memory tab', async () => {
		const wrapper = await mountColumn({ activeMainTab: 'memory' });

		expect(wrapper.find('[data-test-id="stub-memory-graph"]').exists()).toBe(true);
	});
});
