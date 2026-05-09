<script setup lang="ts">
import { computed } from 'vue';
import { N8nText, N8nSwitch } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useUIStore } from '@/app/stores/ui.store';
import type { AgentJsonConfig } from '../types';
import { AGENT_CROSS_THREAD_MEMORY_CREDENTIAL_MODAL_KEY } from '../constants';

const props = withDefaults(
	defineProps<{ config: AgentJsonConfig | null; disabled?: boolean; embedded?: boolean }>(),
	{
		disabled: false,
		embedded: false,
	},
);
const emit = defineEmits<{ 'update:config': [changes: Partial<AgentJsonConfig>] }>();

const i18n = useI18n();
const uiStore = useUIStore();
const memory = computed(() => (props.config?.memory?.enabled ? props.config.memory : null));
const crossThreadFacts = computed(() => props.config?.memory?.crossThreadFacts ?? null);
const crossThreadMemoryEnabled = computed(() => crossThreadFacts.value?.enabled === true);
const crossThreadMemoryCredential = computed(() =>
	crossThreadFacts.value?.enabled ? crossThreadFacts.value.credential : null,
);

function onEnableMemory() {
	emit('update:config', {
		memory: { enabled: true, storage: 'n8n', lastMessages: 10 },
	});
}

function onDisableMemory() {
	emit('update:config', {
		memory: { ...(props.config?.memory ?? { storage: 'n8n' as const }), enabled: false },
	});
}

function onMemoryToggle(enabled: boolean) {
	if (enabled) {
		onEnableMemory();
	} else {
		onDisableMemory();
	}
}

function enableCrossThreadMemory(credentialId: string) {
	const existingMemory = props.config?.memory;
	const updatedMemory: NonNullable<AgentJsonConfig['memory']> = {
		...existingMemory,
		enabled: true,
		storage: 'n8n',
		lastMessages: existingMemory?.lastMessages ?? 10,
		crossThreadFacts: {
			enabled: true,
			credential: credentialId,
		},
	};

	emit('update:config', { memory: updatedMemory });
}

function disableCrossThreadMemory() {
	const updatedMemory: NonNullable<AgentJsonConfig['memory']> = {
		...props.config?.memory,
		enabled: props.config?.memory?.enabled ?? false,
		storage: 'n8n',
		crossThreadFacts: { enabled: false },
	};

	emit('update:config', { memory: updatedMemory });
}

function onCrossThreadMemoryToggle(enabled: boolean) {
	if (!enabled) {
		disableCrossThreadMemory();
		return;
	}

	uiStore.openModalWithData({
		name: AGENT_CROSS_THREAD_MEMORY_CREDENTIAL_MODAL_KEY,
		data: {
			initialValue: crossThreadMemoryCredential.value,
			onSelect: enableCrossThreadMemory,
		},
	});
}
</script>

<template>
	<div
		:class="[$style.container, props.disabled && $style.disabled]"
		:inert="props.disabled || undefined"
	>
		<div :class="$style.row">
			<div :class="$style.titleGroup">
				<N8nText tag="h3" :bold="true">{{ i18n.baseText('agents.builder.memory.title') }}</N8nText>
				<N8nText size="small" color="text-light">
					{{ i18n.baseText('agents.builder.memory.description') }}
				</N8nText>
			</div>
			<N8nSwitch
				:model-value="memory !== null"
				:disabled="props.disabled"
				data-testid="agent-memory-toggle"
				@update:model-value="onMemoryToggle"
			/>
		</div>

		<div :class="$style.row">
			<div :class="$style.titleGroup">
				<N8nText size="small" :bold="true">{{
					i18n.baseText('agents.builder.memory.crossThreadFacts.label')
				}}</N8nText>
				<N8nText size="small" color="text-light">
					{{ i18n.baseText('agents.builder.memory.crossThreadFacts.hint') }}
				</N8nText>
			</div>
			<N8nSwitch
				:model-value="crossThreadMemoryEnabled"
				:disabled="props.disabled"
				data-testid="agent-cross-thread-memory-toggle"
				@update:model-value="(value) => onCrossThreadMemoryToggle(Boolean(value))"
			/>
		</div>
	</div>
</template>

<style module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	width: 100%;
	height: 100%;
	overflow-y: auto;
}

.titleGroup {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	flex: 1;
	min-width: 0;
}

.row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}

/* Scoped overlay for read-only builder states. */
.container.disabled > :not(.titleGroup) {
	pointer-events: none;
	opacity: 0.6;
}

.inlineInput {
	width: 70px;
	text-align: center;
	padding: var(--spacing--4xs) var(--spacing--3xs);
	border: var(--border);
	border-radius: var(--radius);
	background-color: var(--background--hover);
	color: var(--text-color);
	font-size: var(--font-size--sm);
	font-family: var(--font-family);
	outline: none;
}

.inlineInput:focus {
	border-color: var(--background--brand);
}

.divider {
	border: none;
	border-top: var(--border);
	margin: var(--spacing--2xs) 0;
}
</style>
