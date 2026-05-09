<script setup lang="ts">
import type {
	AgentMemoryFactDto,
	AgentMemoryFactsResponse,
	AgentMemoryFactSourceThreadDto,
} from '@n8n/api-types';
import {
	N8nBadge,
	N8nCallout,
	N8nDialog,
	N8nIcon,
	N8nRadioButtons,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { Background } from '@vue-flow/background';
import {
	Handle,
	Position,
	VueFlow,
	type Edge,
	type Node,
	type NodeMouseEvent,
} from '@vue-flow/core';
import { computed, ref, watch } from 'vue';

import { useToast } from '@/app/composables/useToast';
import { GRID_SIZE } from '@/app/utils/nodeViewUtils';
import { convertToDisplayDate } from '@/app/utils/formatters/dateFormatter';

import { getAgentMemoryFacts } from '../composables/useAgentApi';

const props = defineProps<{
	projectId: string;
	agentId: string;
	crossThreadMemoryEnabled: boolean;
}>();

type MemoryView = 'sourceGraph' | 'factList';
type SourceGraphNodeData = {
	label: string;
	subtitle: string;
	count?: number;
	icon?: string;
	factId?: string;
	content?: string;
	testId: string;
};
type SourceGroup = {
	key: string;
	label: string;
	subtitle: string;
	sourceThread: AgentMemoryFactSourceThreadDto | null;
	facts: AgentMemoryFactDto[];
};

const UNKNOWN_SOURCE_KEY = 'unknown-source';
const MAX_FACTS_PER_RING = 8;
const SOURCE_GRAPH_COLUMNS = 3;
const SOURCE_CLUSTER_WIDTH = 720;
const SOURCE_CLUSTER_HEIGHT = 500;
const SOURCE_NODE_WIDTH = 180;
const SOURCE_NODE_HEIGHT = 92;
const FACT_NODE_WIDTH = 160;
const FACT_NODE_HEIGHT = 76;
const SOURCE_CLUSTER_GAP = 96;

const i18n = useI18n();
const rootStore = useRootStore();
const toast = useToast();

const memoryFacts = ref<AgentMemoryFactsResponse | null>(null);
const loading = ref(false);
const hasLoadError = ref(false);
const selectedFactId = ref<string | null>(null);
const selectedView = ref<MemoryView>('sourceGraph');
let loadRequestId = 0;

const viewOptions = computed(() => [
	{
		label: i18n.baseText('agents.builder.memoryGraph.view.sourceGraph'),
		value: 'sourceGraph',
	},
	{
		label: i18n.baseText('agents.builder.memoryGraph.view.factList'),
		value: 'factList',
	},
]);
const facts = computed(() => memoryFacts.value?.facts ?? []);
const sourceThreadsById = computed(
	() => new Map((memoryFacts.value?.sourceThreads ?? []).map((thread) => [thread.id, thread])),
);
const sourceGroups = computed<SourceGroup[]>(() => {
	const groupedFacts = new Map<string, AgentMemoryFactDto[]>();

	for (const fact of facts.value) {
		const key = fact.sourceThreadId ?? UNKNOWN_SOURCE_KEY;
		groupedFacts.set(key, [...(groupedFacts.get(key) ?? []), fact]);
	}

	return Array.from(groupedFacts.entries()).map(([key, groupFacts]) => {
		const sourceThread =
			key === UNKNOWN_SOURCE_KEY ? null : (sourceThreadsById.value.get(key) ?? null);
		const label =
			sourceThread?.title ??
			(sourceThread
				? sourceSessionLabel(sourceThread)
				: i18n.baseText('agents.builder.memoryGraph.source.unknown'));
		const subtitle = sourceThread
			? sourceSessionLabel(sourceThread)
			: i18n.baseText('agents.builder.memoryGraph.source.unknownSubtitle');

		return {
			key,
			label,
			subtitle,
			sourceThread,
			facts: groupFacts,
		};
	});
});
const sourceCount = computed(() => sourceGroups.value.length);
const sourceGraphNodes = computed<Array<Node<SourceGraphNodeData>>>(() =>
	sourceGroups.value.flatMap((group, groupIndex) => {
		const clusterPosition = getClusterPosition(groupIndex);
		const sourceNodeId = sourceNodeIdFor(group.key);
		const center = {
			x: clusterPosition.x + SOURCE_CLUSTER_WIDTH / 2,
			y: clusterPosition.y + SOURCE_CLUSTER_HEIGHT / 2,
		};
		const nodes: Array<Node<SourceGraphNodeData>> = [
			{
				id: sourceNodeId,
				type: 'source',
				position: {
					x: center.x - SOURCE_NODE_WIDTH / 2,
					y: center.y - SOURCE_NODE_HEIGHT / 2,
				},
				data: {
					label: group.label,
					subtitle: group.subtitle,
					count: group.facts.length,
					icon: group.sourceThread ? 'messages-square' : 'message-square',
					testId: `agent-memory-source-cluster-${group.key}`,
				},
				selectable: false,
				draggable: false,
				sourcePosition: Position.Right,
			},
		];

		for (const [factIndex, fact] of group.facts.entries()) {
			const factPosition = getFactCanvasPosition(center, factIndex, group.facts.length);
			nodes.push({
				id: factNodeIdFor(fact.id),
				type: 'fact',
				position: {
					x: factPosition.x - FACT_NODE_WIDTH / 2,
					y: factPosition.y - FACT_NODE_HEIGHT / 2,
				},
				data: {
					label: sourceThreadLabel(fact),
					subtitle: sourceThreadSubtitle(fact),
					factId: fact.id,
					content: fact.content,
					testId: `agent-memory-source-fact-${fact.id}`,
				},
				selectable: true,
				draggable: false,
				targetPosition: Position.Left,
			});
		}

		return nodes;
	}),
);
const sourceGraphEdges = computed<Edge[]>(() =>
	sourceGroups.value.flatMap((group) =>
		group.facts.map((fact) => ({
			id: `${sourceNodeIdFor(group.key)}-${factNodeIdFor(fact.id)}`,
			source: sourceNodeIdFor(group.key),
			target: factNodeIdFor(fact.id),
			type: 'straight',
			selectable: false,
			style: {
				stroke: 'var(--color--foreground--base)',
				strokeWidth: 2,
			},
		})),
	),
);
const selectedFact = computed(
	() => facts.value.find((fact) => fact.id === selectedFactId.value) ?? null,
);
const selectedFactSourceName = computed(() =>
	selectedFact.value ? sourceThreadName(selectedFact.value) : '',
);
const memorySummary = computed(() =>
	i18n.baseText('agents.builder.memoryGraph.summary', {
		interpolate: {
			factCount: String(facts.value.length),
			sourceCount: String(sourceCount.value),
		},
	}),
);
const shouldShowEmptyState = computed(
	() => !loading.value && !hasLoadError.value && facts.value.length === 0,
);
const factDialogOpen = computed({
	get: () => selectedFact.value !== null,
	set: (open: boolean) => {
		if (!open) selectedFactId.value = null;
	},
});

function formatDate(value: string): string {
	return convertToDisplayDate(value).date;
}

function formatDateTime(value: string): string {
	const { date, time } = convertToDisplayDate(value);
	return `${date} ${time}`;
}

function sourceNodeIdFor(sourceKey: string): string {
	return `source:${sourceKey}`;
}

function factNodeIdFor(factId: string): string {
	return `fact:${factId}`;
}

function getClusterPosition(index: number) {
	const column = index % SOURCE_GRAPH_COLUMNS;
	const row = Math.floor(index / SOURCE_GRAPH_COLUMNS);

	return {
		x: column * (SOURCE_CLUSTER_WIDTH + SOURCE_CLUSTER_GAP),
		y: row * (SOURCE_CLUSTER_HEIGHT + SOURCE_CLUSTER_GAP),
	};
}

function getFactCanvasPosition(center: { x: number; y: number }, index: number, total: number) {
	const ring = Math.floor(index / MAX_FACTS_PER_RING);
	const indexInRing = index % MAX_FACTS_PER_RING;
	const itemsInRing = Math.min(MAX_FACTS_PER_RING, total - ring * MAX_FACTS_PER_RING);
	const angleOffset = ring % 2 === 0 ? 0 : Math.PI / itemsInRing;
	const angle = -Math.PI / 2 + (Math.PI * 2 * indexInRing) / itemsInRing + angleOffset;
	const radiusX = 220 + ring * 70;
	const radiusY = 150 + ring * 56;

	return {
		x: center.x + Math.cos(angle) * radiusX,
		y: center.y + Math.sin(angle) * radiusY,
	};
}

function sourceSessionLabel(thread: AgentMemoryFactSourceThreadDto): string {
	return i18n.baseText('agents.builder.memoryGraph.source.session', {
		interpolate: { sessionNumber: String(thread.sessionNumber) },
	});
}

function sourceThreadLabel(fact: AgentMemoryFactDto): string {
	if (!fact.sourceThreadId) return i18n.baseText('agents.builder.memoryGraph.source.unknown');

	const sourceThread = sourceThreadsById.value.get(fact.sourceThreadId);
	if (!sourceThread) return fact.sourceThreadId;

	return sourceThread.title ?? sourceSessionLabel(sourceThread);
}

function sourceThreadSubtitle(fact: AgentMemoryFactDto): string {
	if (!fact.sourceThreadId)
		return i18n.baseText('agents.builder.memoryGraph.source.unknownSubtitle');

	const sourceThread = sourceThreadsById.value.get(fact.sourceThreadId);
	if (!sourceThread) return fact.sourceThreadId;

	return sourceSessionLabel(sourceThread);
}

function sourceThreadName(fact: AgentMemoryFactDto): string {
	if (!fact.sourceThreadId) return i18n.baseText('agents.builder.memoryGraph.source.unknown');

	const sourceThread = sourceThreadsById.value.get(fact.sourceThreadId);

	return sourceThread?.title ?? i18n.baseText('agents.builder.memoryGraph.notAvailable');
}

function selectFact(factId: string) {
	selectedFactId.value = factId;
}

function isSourceGraphNodeData(data: unknown): data is SourceGraphNodeData {
	return typeof data === 'object' && data !== null && 'testId' in data;
}

function onSourceGraphNodeClick({ node }: NodeMouseEvent) {
	const data: unknown = node.data;
	if (!isSourceGraphNodeData(data) || typeof data.factId !== 'string') return;

	selectFact(data.factId);
}

async function loadMemoryFacts() {
	const requestId = ++loadRequestId;
	loading.value = true;
	hasLoadError.value = false;

	try {
		const response = await getAgentMemoryFacts(
			rootStore.restApiContext,
			props.projectId,
			props.agentId,
		);
		if (requestId !== loadRequestId) return;

		memoryFacts.value = response;
		if (!response.facts.some((fact) => fact.id === selectedFactId.value)) {
			selectedFactId.value = null;
		}
	} catch (error) {
		if (requestId !== loadRequestId) return;

		hasLoadError.value = true;
		memoryFacts.value = null;
		selectedFactId.value = null;
		toast.showError(error, i18n.baseText('agents.builder.memoryGraph.loadError'));
	} finally {
		if (requestId === loadRequestId) {
			loading.value = false;
		}
	}
}

watch(
	() => [props.projectId, props.agentId],
	() => {
		void loadMemoryFacts();
	},
	{ immediate: true },
);
</script>

<template>
	<div :class="$style.panel" data-test-id="agent-memory-graph-panel">
		<div :class="$style.toolbar">
			<N8nRadioButtons
				v-model="selectedView"
				:options="viewOptions"
				size="small"
				:aria-label="i18n.baseText('agents.builder.memoryGraph.view.ariaLabel')"
			/>
			<N8nText size="small" color="text-light" data-test-id="agent-memory-graph-summary">
				{{ memorySummary }}
			</N8nText>
		</div>

		<N8nCallout
			v-if="!crossThreadMemoryEnabled"
			:class="$style.offState"
			theme="secondary"
			icon="info"
			slim
			data-test-id="agent-memory-graph-off-state"
		>
			<strong>{{ i18n.baseText('agents.builder.memoryGraph.off.title') }}</strong>
			{{ i18n.baseText('agents.builder.memoryGraph.off.description') }}
		</N8nCallout>

		<div v-if="loading" :class="$style.emptyState" data-test-id="agent-memory-graph-loading">
			<N8nIcon icon="spinner" :size="22" :spin="true" />
			<N8nText color="text-light">
				{{ i18n.baseText('agents.builder.memoryGraph.loading') }}
			</N8nText>
		</div>

		<div
			v-else-if="hasLoadError"
			:class="$style.emptyState"
			data-test-id="agent-memory-graph-error"
		>
			<N8nIcon icon="triangle-alert" :size="22" />
			<N8nText color="text-light">
				{{ i18n.baseText('agents.builder.memoryGraph.error') }}
			</N8nText>
		</div>

		<div
			v-else-if="shouldShowEmptyState"
			:class="$style.emptyState"
			data-test-id="agent-memory-graph-empty"
		>
			<N8nIcon icon="brain" :size="22" />
			<N8nText bold>{{ i18n.baseText('agents.builder.memoryGraph.empty.title') }}</N8nText>
			<N8nText size="small" color="text-light">
				{{ i18n.baseText('agents.builder.memoryGraph.empty.description') }}
			</N8nText>
		</div>

		<div v-else :class="$style.memoryBody">
			<div
				v-if="selectedView === 'sourceGraph'"
				:class="$style.sourceGraph"
				data-test-id="agent-memory-source-graph"
			>
				<VueFlow
					:nodes="sourceGraphNodes"
					:edges="sourceGraphEdges"
					:fit-view-on-init="true"
					:nodes-draggable="false"
					:nodes-connectable="false"
					:pan-on-scroll="true"
					:zoom-on-scroll="true"
					data-test-id="agent-memory-source-canvas"
					@node-click="onSourceGraphNodeClick"
				>
					<Background pattern-color="var(--canvas--dot--color)" :gap="GRID_SIZE" />

					<template #node-source="{ data }">
						<div :class="$style.sourceHub" :data-test-id="data.testId">
							<Handle type="source" :position="Position.Right" :class="$style.hiddenHandle" />
							<N8nIcon :icon="data.icon" :size="16" />
							<span :class="$style.sourceHubLabel">{{ data.label }}</span>
							<span :class="$style.sourceHubMeta">{{ data.subtitle }}</span>
							<N8nBadge theme="tertiary" size="small" :show-border="false">
								{{ data.count }}
							</N8nBadge>
						</div>
					</template>

					<template #node-fact="{ data }">
						<button
							type="button"
							:class="{
								[$style.graphFactNode]: true,
								[$style.selectedFactCard]: selectedFact?.id === data.factId,
							}"
							:data-test-id="data.testId"
							@click="selectFact(data.factId)"
						>
							<Handle type="target" :position="Position.Left" :class="$style.hiddenHandle" />
							<span>{{ data.content }}</span>
						</button>
					</template>
				</VueFlow>
			</div>

			<div v-else :class="$style.factBoard" data-test-id="agent-memory-fact-board">
				<button
					v-for="fact in facts"
					:key="fact.id"
					type="button"
					:class="{
						[$style.factCard]: true,
						[$style.selectedFactCard]: selectedFact?.id === fact.id,
					}"
					:data-test-id="`agent-memory-fact-card-${fact.id}`"
					@click="selectFact(fact.id)"
				>
					<span :class="$style.factPreview">{{ fact.content }}</span>
					<span :class="$style.factProvenance">
						<N8nBadge theme="tertiary" size="small" :show-border="false">
							{{ sourceThreadLabel(fact) }}
						</N8nBadge>
						<span :class="$style.factSourceMeta">{{ sourceThreadSubtitle(fact) }}</span>
						<span :class="$style.factSourceMeta">
							{{ i18n.baseText('agents.builder.memoryGraph.factCard.created') }}
							{{ formatDate(fact.createdAt) }}
						</span>
					</span>
				</button>
			</div>
		</div>

		<N8nDialog
			v-model:open="factDialogOpen"
			:header="i18n.baseText('agents.builder.memoryGraph.inspector.title')"
			size="medium"
			data-test-id="agent-memory-fact-dialog"
			@update:open="factDialogOpen = $event"
		>
			<div v-if="selectedFact" :class="$style.factDetails">
				<p :class="$style.factContent">{{ selectedFact.content }}</p>

				<div :class="$style.detailFooter">
					<span>{{ selectedFactSourceName }}</span>
					<span>{{ formatDateTime(selectedFact.updatedAt) }}</span>
				</div>
			</div>
		</N8nDialog>
	</div>
</template>

<style lang="scss" module>
.panel {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	width: 100%;
	min-height: 0;
	padding: var(--spacing--lg);
}

.toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}

.offState {
	max-width: 46rem;
}

.emptyState {
	display: flex;
	flex: 1;
	min-height: 24rem;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: var(--spacing--2xs);
	text-align: center;
	border: var(--border);
	border-radius: var(--radius);
	background: var(--background--surface);
	padding: var(--spacing--xl);
}

.memoryBody {
	flex: 1;
	min-height: 32rem;
	height: clamp(32rem, 68vh, 44rem);
}

.sourceGraph {
	min-width: 0;
	height: 100%;
	overflow: hidden;
	border: var(--border);
	border-radius: var(--radius);
	background: var(--canvas--color--background);

	:global(.vue-flow) {
		width: 100%;
		height: 100%;
		background: var(--canvas--color--background);
	}

	:global(.vue-flow__edge-path) {
		stroke: var(--color--foreground--base);
		stroke-width: 2;
	}

	:global(.vue-flow__node) {
		background: transparent;
		border: 0;
		box-shadow: none;
	}
}

.sourceHub {
	position: relative;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: var(--spacing--4xs);
	width: 11rem;
	min-height: 5.75rem;
	padding: var(--spacing--xs);
	text-align: center;
	color: var(--color--text);
	background: var(--node--color--background, var(--background--surface));
	border: var(--border);
	border-radius: var(--radius--lg);
}

.sourceHubLabel {
	max-width: 100%;
	color: var(--color--text);
	font-size: var(--font-size--sm);
	font-weight: var(--font-weight--medium);
	line-height: var(--line-height--sm);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.sourceHubMeta {
	max-width: 100%;
	color: var(--color--text--light);
	font-size: var(--font-size--2xs);
	line-height: var(--line-height--sm);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.graphFactNode {
	position: relative;
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
	width: 9.5rem;
	min-height: 4.5rem;
	padding: var(--spacing--2xs);
	color: var(--color--text);
	text-align: left;
	background: var(--background--surface);
	border: var(--border);
	border-radius: var(--radius);
	cursor: pointer;

	&:hover,
	&:focus-visible {
		border-color: var(--color--primary);
	}

	span {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		overflow: hidden;
		overflow-wrap: anywhere;
		font-size: var(--font-size--2xs);
		line-height: var(--line-height--sm);
	}
}

.hiddenHandle {
	width: var(--spacing--xs);
	height: var(--spacing--xs);
	min-width: var(--spacing--xs);
	min-height: var(--spacing--xs);
	background: transparent;
	border: 0;
	opacity: 0;
	pointer-events: none;
}

.factBoard {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
	grid-auto-rows: min-content;
	align-content: start;
	gap: var(--spacing--xs);
	min-width: 0;
	min-height: 32rem;
	height: 100%;
	overflow: auto;
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius);
	background: var(--canvas--color--background);
}

.factCard {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	min-height: 9rem;
	padding: var(--spacing--sm);
	color: var(--color--text);
	text-align: left;
	background: var(--background--surface);
	border: var(--border);
	border-radius: var(--radius--lg);
	cursor: pointer;
	box-shadow: none;

	&:hover,
	&:focus-visible {
		border-color: var(--color--primary);
	}
}

.selectedFactCard {
	border-color: var(--color--primary);
	box-shadow: 0 0 0 2px var(--canvas--color--selected-transparent);
}

.factPreview {
	color: var(--color--text);
	font-size: var(--font-size--sm);
	font-weight: var(--font-weight--medium);
	line-height: var(--line-height--md);
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 3;
	overflow: hidden;
	overflow-wrap: anywhere;
}

.factProvenance {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--3xs);
	margin-top: auto;
}

.factSourceMeta {
	color: var(--color--text--light);
	font-size: var(--font-size--2xs);
	line-height: var(--line-height--sm);
}

.factDetails {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	min-width: 0;
	padding-top: var(--spacing--md);
}

.factContent {
	margin: 0;
	color: var(--color--text);
	font-size: var(--font-size--sm);
	line-height: var(--line-height--md);
	overflow-wrap: anywhere;
}

.detailFooter {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: end;
	gap: var(--spacing--md);
	padding-top: var(--spacing--sm);
	border-top: var(--border);

	span {
		min-width: 0;
		color: var(--color--text--light);
		font-size: var(--font-size--xs);
		line-height: var(--line-height--sm);
		overflow-wrap: anywhere;
	}

	span:last-child {
		text-align: right;
	}
}

@media (max-width: 60rem) {
	.toolbar {
		align-items: flex-start;
		flex-direction: column;
	}

	.detailFooter {
		grid-template-columns: 1fr;
	}

	.detailFooter span:last-child {
		text-align: left;
	}
}
</style>
