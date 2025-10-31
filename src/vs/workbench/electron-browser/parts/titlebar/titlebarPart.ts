/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getZoomFactor } from '../../../../base/browser/browser.js';
import { getWindow, getWindowId } from '../../../../base/browser/dom.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService, IConfigurationChangeEvent } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { isBigSurOrNewer } from '../../../../base/common/platform.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { BrowserTitlebarPart, BrowserTitleService, IAuxiliaryTitlebarPart } from '../../../browser/parts/titlebar/titlebarPart.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { useWindowControlsOverlay, DEFAULT_CUSTOM_TITLEBAR_HEIGHT } from '../../../../platform/window/common/window.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { NativeMenubarControl } from './menubarControl.js';
import { IEditorGroupsContainer, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { CodeWindow, mainWindow } from '../../../../base/browser/window.js';
import { IsWindowAlwaysOnTopContext } from '../../../common/contextkeys.js';

export class NativeTitlebarPart extends BrowserTitlebarPart {

	//#region IView

	override get minimumHeight(): number {
		return (this.isCommandCenterVisible ? DEFAULT_CUSTOM_TITLEBAR_HEIGHT : this.macTitlebarSize) / (this.preventZoom ? getZoomFactor(getWindow(this.element)) : 1);
	}
	override get maximumHeight(): number { return this.minimumHeight; }

	private bigSurOrNewer: boolean;
	private get macTitlebarSize() {
		if (this.bigSurOrNewer) {
			return 28; // macOS Big Sur increases title bar height
		}

		return 22;
	}

	//#endregion

	private cachedWindowControlStyles: { bgColor: string; fgColor: string } | undefined;
	private cachedWindowControlHeight: number | undefined;

	constructor(
		id: string,
		targetWindow: CodeWindow,
		editorGroupsContainer: IEditorGroupsContainer,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		super(id, targetWindow, editorGroupsContainer, contextMenuService, configurationService, environmentService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, editorService, menuService, keybindingService);

		this.bigSurOrNewer = isBigSurOrNewer(environmentService.os.release);

		this.handleWindowsAlwaysOnTop(targetWindow.vscodeWindowId);
	}

	private async handleWindowsAlwaysOnTop(targetWindowId: number): Promise<void> {
		const isWindowAlwaysOnTopContext = IsWindowAlwaysOnTopContext.bindTo(this.contextKeyService);

		this._register(this.nativeHostService.onDidChangeWindowAlwaysOnTop(({ windowId, alwaysOnTop }) => {
			if (windowId === targetWindowId) {
				isWindowAlwaysOnTopContext.set(alwaysOnTop);
			}
		}));

		isWindowAlwaysOnTopContext.set(await this.nativeHostService.isWindowAlwaysOnTop({ targetWindowId }));
	}

	protected override onMenubarVisibilityChanged(visible: boolean): void {
		super.onMenubarVisibilityChanged(visible);
	}

	protected override onConfigurationChanged(event: IConfigurationChangeEvent): void {
		super.onConfigurationChanged(event);
	}


	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const result = super.createContentArea(parent);

		// Native menu controller (macOS)
		this._register(this.instantiationService.createInstance(NativeMenubarControl));

		return result;
	}


	override updateStyles(): void {
		super.updateStyles();

		// Part container
		if (this.element) {
			if (useWindowControlsOverlay(this.configurationService)) {
				if (
					!this.cachedWindowControlStyles ||
					this.cachedWindowControlStyles.bgColor !== this.element.style.backgroundColor ||
					this.cachedWindowControlStyles.fgColor !== this.element.style.color
				) {
					this.nativeHostService.updateWindowControls({
						targetWindowId: getWindowId(getWindow(this.element)),
						backgroundColor: this.element.style.backgroundColor,
						foregroundColor: this.element.style.color
					});
				}
			}
		}
	}

	override layout(width: number, height: number): void {
		super.layout(width, height);

		if (useWindowControlsOverlay(this.configurationService)) {

			// When the user goes into full screen mode, the height of the title bar becomes 0.
			// Instead, set it back to the default titlebar height for Catalina users
			// so that they can have the traffic lights rendered at the proper offset.
			// Ref https://github.com/microsoft/vscode/issues/159862

			const newHeight = (height > 0 || this.bigSurOrNewer) ? Math.round(height * getZoomFactor(getWindow(this.element))) : this.macTitlebarSize;
			if (newHeight !== this.cachedWindowControlHeight) {
				this.cachedWindowControlHeight = newHeight;
				this.nativeHostService.updateWindowControls({
					targetWindowId: getWindowId(getWindow(this.element)),
					height: newHeight
				});
			}
		}
	}
}

export class MainNativeTitlebarPart extends NativeTitlebarPart {

	constructor(
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@INativeHostService nativeHostService: INativeHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		super(Parts.TITLEBAR_PART, mainWindow, editorGroupService.mainPart, contextMenuService, configurationService, environmentService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, nativeHostService, editorGroupService, editorService, menuService, keybindingService);
	}
}

export class AuxiliaryNativeTitlebarPart extends NativeTitlebarPart implements IAuxiliaryTitlebarPart {

	private static COUNTER = 1;

	get height() { return this.minimumHeight; }

	constructor(
		readonly container: HTMLElement,
		editorGroupsContainer: IEditorGroupsContainer,
		private readonly mainTitlebar: BrowserTitlebarPart,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@INativeHostService nativeHostService: INativeHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		const id = AuxiliaryNativeTitlebarPart.COUNTER++;
		super(`workbench.parts.auxiliaryTitle.${id}`, getWindow(container), editorGroupsContainer, contextMenuService, configurationService, environmentService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, nativeHostService, editorGroupService, editorService, menuService, keybindingService);
	}

	override get preventZoom(): boolean {

		// Prevent zooming behavior if any of the following conditions are met:
		// 1. Shrinking below the window control size (zoom < 1)
		// 2. No custom items are present in the main title bar
		// The auxiliary title bar never contains any zoomable items itself,
		// but we want to match the behavior of the main title bar.

		return getZoomFactor(getWindow(this.element)) < 1 || !this.mainTitlebar.hasZoomableElements;
	}
}

export class NativeTitleService extends BrowserTitleService {

	protected override createMainTitlebarPart(): MainNativeTitlebarPart {
		return this.instantiationService.createInstance(MainNativeTitlebarPart);
	}

	protected override doCreateAuxiliaryTitlebarPart(container: HTMLElement, editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): AuxiliaryNativeTitlebarPart {
		return instantiationService.createInstance(AuxiliaryNativeTitlebarPart, container, editorGroupsContainer, this.mainPart);
	}
}
