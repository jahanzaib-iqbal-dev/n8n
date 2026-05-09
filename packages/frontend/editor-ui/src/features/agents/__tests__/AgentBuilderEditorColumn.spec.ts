/* eslint-disable import-x/no-extraneous-dependencies -- test-only Vue mounting */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import AgentBuilderEditorColumn from '../components/AgentBuilderEditorColumn.vue';

vi.mock('@n8n/i18n', () => ({
	useI18n: () => ({
		baseText: (key: string) =>
			({
				'agents.builder.memory.title': 'Session Memory',
				'agents.builder.memory.description':
					'Keeps recent messages from this session available as context.',
				'agents.builder.memory.crossThreadFacts.label': 'Memory',
				'agents.builder.memory.crossThreadFacts.hint':
					'Remember durable facts across sessions with this agent.',
				'agents.builder.editorColumn.ariaLabel': 'Agent editor',
			})[key] ?? key,
	}),
}));

vi.mock('@/app/stores/ui.store', () => ({
	useUIStore: () => ({ openModalWithData: vi.fn() }),
}));

vi.mock('@n8n/design-system', () => ({
	N8nCard: { template: '<div><slot /></div>', props: ['variant'] },
	N8nHeading: { template: '<h2><slot /></h2>', props: ['size'] },
	N8nRadioButtons: { template: '<div />', props: ['modelValue', 'options'] },
	N8nSwitch: { template: '<button data-test-id="agent-memory-toggle"></button>' },
	N8nText: { template: '<span><slot /></span>', props: ['tag', 'bold', 'size', 'color'] },
}));

function mountColumn() {
	return mount(AgentBuilderEditorColumn, {
		props: {
			activeMainTab: 'agent',
			mainTabOptions: [{ label: 'Agent', value: 'agent' }],
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
			},
		},
	});
}

describe('AgentBuilderEditorColumn', () => {
	it('renders session memory and memory rows in the builder memory card', () => {
		const wrapper = mountColumn();

		expect(wrapper.text()).toContain('Session Memory');
		expect(wrapper.text()).toContain(
			'Keeps recent messages from this session available as context.',
		);
		expect(wrapper.text()).toContain('Memory');
		expect(wrapper.text()).toContain('Remember durable facts across sessions with this agent.');
		expect(wrapper.text()).not.toContain('Automatic memory');
		expect(wrapper.find('[data-test-id="agent-observational-memory-toggle"]').exists()).toBe(false);
	});
});
