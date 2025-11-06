// renViewManager.ts
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { IRenView } from "../views/renView.interface.js";
import { CodeView } from "../views/codeView.js";
import { MonitorXView } from "../views/monitorXView.js";
import { GraphView } from "../views/graphView.js";
import { IInstantiationService } from "../../../../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";

export type RenViewMode = "code" | "monitorx" | "graph";

export const IRenViewManager =
	createDecorator<IRenViewManager>("IRenViewManager");

export interface IRenViewManager {
	readonly _serviceBrand: undefined;
	getGraphView(): GraphView | undefined;
	getCurrentView(): RenViewMode;
	switchToView(mode: RenViewMode): void;
	setContentArea(contentArea: HTMLElement): void;
}

export class RenViewManager extends Disposable implements IRenViewManager {
	readonly _serviceBrand: undefined;
	private readonly _views = new Map<RenViewMode, IRenView>();
	private _currentView: RenViewMode = "code";
	private _contentArea: HTMLElement | null = null;

	constructor(
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this.initializeViews();
	}

	private initializeViews(): void {
		try {
			this.logService.info("[RenViewManager] Initializing views...");

			// Initialize CodeView (no DI needed)
			try {
				this._views.set("code", this._register(new CodeView()));
				this.logService.info(
					"[RenViewManager] CodeView initialized successfully"
				);
			} catch (error) {
				this.logService.error(
					"[RenViewManager] Failed to initialize CodeView:",
					error
				);
			}

			// Initialize MonitorXView (uses DI)
			try {
				const monitorXView = this._register(
					this.instantiationService.createInstance(MonitorXView)
				);
				this._views.set("monitorx", monitorXView);
				this.logService.info(
					"[RenViewManager] MonitorXView initialized successfully"
				);
			} catch (error) {
				this.logService.error(
					"[RenViewManager] Failed to initialize MonitorXView:",
					error
				);
				console.error(
					"[RenViewManager] MonitorXView initialization error:",
					error
				);
			}

			// Initialize GraphView (uses DI)
			try {
				const graphView = this._register(
					this.instantiationService.createInstance(GraphView)
				);
				this._views.set("graph", graphView);
				this.logService.info(
					"[RenViewManager] GraphView initialized successfully"
				);
			} catch (error) {
				this.logService.error(
					"[RenViewManager] Failed to initialize GraphView:",
					error
				);
				console.error(
					"[RenViewManager] GraphView initialization error:",
					error
				);
			}

			this.logService.info(
				`[RenViewManager] View initialization complete. Registered ${this._views.size} views`
			);
		} catch (error) {
			this.logService.error(
				"[RenViewManager] Critical error during view initialization:",
				error
			);
			console.error("[RenViewManager] Critical initialization error:", error);
		}
	}

	setContentArea(contentArea: HTMLElement): void {
		this._contentArea = contentArea;
	}

	switchToView(mode: RenViewMode): void {
		if (this._currentView === mode) {
			return;
		}

		// Hide current view
		const currentView = this._views.get(this._currentView);
		if (currentView && this._contentArea) {
			currentView.hide();
		}

		// Show new view
		this._currentView = mode;
		const newView = this._views.get(mode);
		if (newView && this._contentArea) {
			newView.show(this._contentArea);
		}
	}

	getCurrentView(): RenViewMode {
		return this._currentView;
	}

	public getGraphView(): GraphView | undefined {
		const view = this._views.get("graph");
		return view instanceof GraphView ? view : undefined;
	}
}
