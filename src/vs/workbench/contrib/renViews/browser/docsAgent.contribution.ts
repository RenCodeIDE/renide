import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IDocsService } from './services/docsService.js';

export class DocsAgentContribution extends Disposable implements IWorkbenchContribution {
private readonly store = new DisposableStore();
private interval: number | undefined;

constructor(
    @IDocsService private readonly docsService: IDocsService,
) {
super();

// Placeholder background loop – later this will call server to build docs
this.interval = window.setInterval(() => {
    // Future: incremental updates; for now generate placeholder content
    void this.docsService.generateDocs('auto');
}, 60_000);

this.store.add({ dispose: () => {
if (this.interval !== undefined) {
window.clearInterval(this.interval);
this.interval = undefined;
}
} });
}

override dispose(): void {
this.store.dispose();
super.dispose();
}
}

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(DocsAgentContribution, LifecyclePhase.Restored);


