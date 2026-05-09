/* eslint-disable import-x/no-extraneous-dependencies -- test-only Vue mounting */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';

import AgentMemoryPanel from '../components/AgentMemoryPanel.vue';
import type { AgentJsonConfig } from '../types';

const { openModalWithDataMock } = vi.hoisted(() => ({
	openModalWithDataMock: vi.fn(),
}));

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
			})[key] ?? key,
	}),
}));

vi.mock('@/app/stores/ui.store', () => ({
	useUIStore: () => ({ openModalWithData: openModalWithDataMock }),
}));

const globalStubs = {
	N8nText: { template: '<span><slot /></span>', props: ['tag', 'bold', 'size', 'color'] },
	N8nSwitch: {
		props: ['modelValue', 'disabled'],
		emits: ['update:modelValue'],
		template:
			'<button v-bind="$attrs" :disabled="disabled" :data-checked="modelValue" @click="$emit(\'update:modelValue\', !modelValue)" />',
	},
};

function makeConfig(overrides: Partial<AgentJsonConfig> = {}): AgentJsonConfig {
	return {
		name: 'A',
		instructions: 'i',
		model: 'anthropic/claude-sonnet-4-6',
		credential: 'c',
		...overrides,
	} as AgentJsonConfig;
}

describe('AgentMemoryPanel', () => {
	beforeEach(() => {
		openModalWithDataMock.mockClear();
	});

	it('renders session memory and cross-session memory controls', () => {
		const wrapper = mount(AgentMemoryPanel, {
			props: { config: makeConfig() },
			global: { stubs: globalStubs },
		});

		expect(wrapper.text()).toContain('Session Memory');
		expect(wrapper.text()).toContain(
			'Keeps recent messages from this session available as context.',
		);
		expect(wrapper.text()).toContain('Memory');
		expect(wrapper.text()).toContain('Remember durable facts across sessions with this agent.');
		expect(wrapper.find('[data-testid="agent-memory-toggle"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="agent-cross-thread-memory-toggle"]').exists()).toBe(true);
	});

	it('opens the credential modal without updating config when memory is toggled on', async () => {
		const wrapper = mount(AgentMemoryPanel, {
			props: { config: makeConfig() },
			global: { stubs: globalStubs },
		});

		await wrapper.find('[data-testid="agent-cross-thread-memory-toggle"]').trigger('click');

		expect(openModalWithDataMock).toHaveBeenCalledWith({
			name: 'agentCrossThreadMemoryCredentialModal',
			data: expect.objectContaining({
				initialValue: null,
				onSelect: expect.any(Function),
			}),
		});
		expect(wrapper.emitted('update:config')).toBeUndefined();
	});

	it('emits the memory config after a credential is selected', async () => {
		const wrapper = mount(AgentMemoryPanel, {
			props: { config: makeConfig() },
			global: { stubs: globalStubs },
		});

		await wrapper.find('[data-testid="agent-cross-thread-memory-toggle"]').trigger('click');
		const payload = openModalWithDataMock.mock.calls[0][0] as {
			data: { onSelect: (credentialId: string) => void };
		};
		payload.data.onSelect('credential-1');

		expect(wrapper.emitted('update:config')).toEqual([
			[
				{
					memory: {
						enabled: true,
						storage: 'n8n',
						lastMessages: 10,
						crossThreadFacts: {
							enabled: true,
							credential: 'credential-1',
						},
					},
				},
			],
		]);
	});

	it('preserves existing memory config when enabling memory', async () => {
		const wrapper = mount(AgentMemoryPanel, {
			props: {
				config: makeConfig({
					memory: {
						enabled: true,
						storage: 'n8n',
						lastMessages: 4,
						semanticRecall: {
							topK: 3,
							scope: 'resource',
						},
					},
				}),
			},
			global: { stubs: globalStubs },
		});

		await wrapper.find('[data-testid="agent-cross-thread-memory-toggle"]').trigger('click');
		const payload = openModalWithDataMock.mock.calls[0][0] as {
			data: { onSelect: (credentialId: string) => void };
		};
		payload.data.onSelect('credential-2');

		const events = wrapper.emitted('update:config') ?? [];
		expect(events[0][0]).toEqual({
			memory: {
				enabled: true,
				storage: 'n8n',
				lastMessages: 4,
				semanticRecall: {
					topK: 3,
					scope: 'resource',
				},
				crossThreadFacts: {
					enabled: true,
					credential: 'credential-2',
				},
			},
		});
	});

	it('emits disabled memory config when toggled off', async () => {
		const wrapper = mount(AgentMemoryPanel, {
			props: {
				config: makeConfig({
					memory: {
						enabled: true,
						storage: 'n8n',
						lastMessages: 10,
						crossThreadFacts: {
							enabled: true,
							credential: 'credential-1',
						},
					},
				}),
			},
			global: { stubs: globalStubs },
		});

		await wrapper.find('[data-testid="agent-cross-thread-memory-toggle"]').trigger('click');

		expect(openModalWithDataMock).not.toHaveBeenCalled();
		const events = wrapper.emitted('update:config') ?? [];
		expect(events[0][0]).toEqual({
			memory: {
				enabled: true,
				storage: 'n8n',
				lastMessages: 10,
				crossThreadFacts: { enabled: false },
			},
		});
	});

	it('disables memory controls when the disabled prop is true', () => {
		const wrapper = mount(AgentMemoryPanel, {
			props: { config: makeConfig(), disabled: true },
			global: { stubs: globalStubs },
		});

		expect(
			wrapper.find('[data-testid="agent-memory-toggle"]').attributes('disabled'),
		).toBeDefined();
		expect(
			wrapper.find('[data-testid="agent-cross-thread-memory-toggle"]').attributes('disabled'),
		).toBeDefined();
	});
});
