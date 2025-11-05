import { localize } from '../../../../../../nls.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ViewPane, IViewPaneOptions } from '../../../../../browser/parts/views/viewPane.js';
import { IDocsService } from '../../services/docsService.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../../common/views.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';

export class DocsViewPane extends ViewPane {
private contentNode: HTMLElement | undefined;

constructor(
    options: IViewPaneOptions,
    @IKeybindingService keybindingService: IKeybindingService,
    @IContextMenuService contextMenuService: IContextMenuService,
    @IConfigurationService configurationService: IConfigurationService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IViewDescriptorService viewDescriptorService: IViewDescriptorService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IOpenerService openerService: IOpenerService,
    @IThemeService themeService: IThemeService,
    @IHoverService hoverService: IHoverService,
    @IDocsService private readonly docsService: IDocsService,
) {
    super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
}
protected override renderBody(container: HTMLElement): void {
super.renderBody(container);

container.classList.add('ren-docs-view');

const wrapper = document.createElement('div');
wrapper.className = 'ren-docs-view__content';
container.appendChild(wrapper);
this.contentNode = wrapper;
const heading = document.createElement('h2');
heading.textContent = localize('renDocs.heading', 'Docs');
wrapper.appendChild(heading);

const p = document.createElement('p');
const latest = this.docsService.getLatestDocs();
p.textContent = latest ?? localize('renDocs.boilerplate', 'Automatic documentation will appear here. This is boilerplate text for now.');
wrapper.appendChild(p);

this._register(this.docsService.onDidUpdateDocs(text => {
    if (!this.contentNode) { return; }
    this.contentNode.textContent = '';
    const h = document.createElement('h2');
    h.textContent = localize('renDocs.heading', 'Docs');
    this.contentNode.appendChild(h);
    const body = document.createElement('pre');
    (body.style as any).whiteSpace = 'pre-wrap';
    body.textContent = text;
    this.contentNode.appendChild(body);
}));
}

override layoutBody(height: number, width: number): void {
// No-op for simple static content; container naturally lays out.
}
}

export class DocsViewModel extends Disposable {}


