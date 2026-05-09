import { computed, effectScope } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_SECTION_KEY } from '../constants';
import { useAgentBuilderMainTabs } from '../composables/useAgentBuilderMainTabs';

const routerMocks = vi.hoisted(() => ({
	route: { query: {} as Record<string, string | undefined> },
	replace: vi.fn(),
}));

vi.mock('vue-router', () => ({
	useRoute: () => routerMocks.route,
	useRouter: () => ({ replace: routerMocks.replace }),
}));

vi.mock('@n8n/i18n', () => ({
	useI18n: () => ({ baseText: (key: string) => key }),
}));

function setupTabs(query: Record<string, string | undefined> = {}) {
	routerMocks.route.query = query;
	const scope = effectScope();
	const result = scope.run(() =>
		useAgentBuilderMainTabs({
			executionsCount: computed(() => 2),
		}),
	);

	if (result === undefined) {
		throw new Error('useAgentBuilderMainTabs did not initialize');
	}

	return {
		...result,
		stop: () => scope.stop(),
	};
}

describe('useAgentBuilderMainTabs', () => {
	beforeEach(() => {
		routerMocks.route.query = {};
		routerMocks.replace.mockReset();
	});

	it('keeps the Memory tab always visible between Agent and Sessions', () => {
		const tabs = setupTabs();

		expect(tabs.mainTabOptions.value.map((option) => option.value)).toEqual([
			'agent',
			'memory',
			'executions',
			'evaluations',
			'raw',
		]);

		tabs.stop();
	});

	it('maps the memory section query to the Memory tab', () => {
		const tabs = setupTabs({ section: MEMORY_SECTION_KEY });

		expect(tabs.activeMainTab.value).toBe('memory');

		tabs.stop();
	});

	it('writes the memory section query when the Memory tab is selected', () => {
		const tabs = setupTabs();

		tabs.activeMainTab.value = 'memory';

		expect(routerMocks.replace).toHaveBeenCalledWith({
			query: { section: MEMORY_SECTION_KEY },
		});

		tabs.stop();
	});
});
