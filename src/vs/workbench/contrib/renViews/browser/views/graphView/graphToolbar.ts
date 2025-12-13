/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { GitHeatmapGranularity, GitHeatmapPayload, GraphMode, FunctionDefinition } from './graphTypes.js';

export interface IGraphToolbarDelegate {
	onModeChanged(mode: GraphMode): void;
	onGranularityChanged(granularity: GitHeatmapGranularity): void;
	onWindowChanged(days: number): void;
	onTimelineSliderChanged(value: number): void;
	onTimelineTogglePlay(): void;
	onTargetAction(): void;
}

export class GraphToolbar extends Disposable {
	private readonly container: HTMLElement;
	private _modeSelect: HTMLSelectElement | null = null;
	private _targetButton: HTMLButtonElement | null = null;
	private _heatmapControls: {
		container: HTMLElement;
		granularitySelect: HTMLSelectElement;
		windowSelect: HTMLSelectElement;
		summary: HTMLElement;
	} | null = null;
	private _timelineControls: {
		container: HTMLElement;
		slider: HTMLInputElement;
		playButton: HTMLButtonElement;
		dateLabel: HTMLElement;
	} | null = null;

	private _isUpdatingProgrammatically = false;

	constructor(
		private readonly delegate: IGraphToolbarDelegate,
		private _mode: GraphMode,
		private _heatmapGranularity: GitHeatmapGranularity,
		private _heatmapWindowDays: number
	) {
		super();
		this.container = this.build();
	}

	getElement(): HTMLElement {
		return this.container;
	}

	private build(): HTMLElement {
		const toolbar = document.createElement('div');
		toolbar.className = 'ren-graph-toolbar';
		toolbar.style.display = 'inline-flex';
		toolbar.style.gap = '8px';
		toolbar.style.margin = '8px 0 0';
		toolbar.style.alignSelf = 'flex-end';

		// View Mode Selector
		const modeLabel = document.createElement('label');
		modeLabel.className = 'ren-graph-toolbar-field';
		modeLabel.textContent = 'View: ';

		const modeSelect = document.createElement('select');
		modeSelect.id = 'renGraphModeSelect';
		modeSelect.className = 'ren-graph-toolbar-select';
		(['file', 'folder', 'workspace', 'gitHeatmap', 'dataFlow', 'changeImpact', 'evolution'] as GraphMode[]).forEach(mode => {
			const option = document.createElement('option');
			option.value = mode;
			option.textContent = this.getModeLabel(mode);
			modeSelect.appendChild(option);
		});
		modeSelect.value = this._mode;
		modeSelect.title = 'Select graph scope';
		modeSelect.addEventListener('change', () => {
			if (this._isUpdatingProgrammatically) {
				return;
			}
			this.delegate.onModeChanged(modeSelect.value as GraphMode);
		});

		modeLabel.appendChild(modeSelect);
		toolbar.appendChild(modeLabel);
		this._modeSelect = modeSelect;

		// Target Action Button
		const targetButton = document.createElement('button');
		targetButton.className = 'ren-graph-toolbar-btn';
		targetButton.addEventListener('click', () => {
			this.delegate.onTargetAction();
		});
		toolbar.appendChild(targetButton);
		this._targetButton = targetButton;

		// Heatmap Controls
		this._heatmapControls = this.buildHeatmapControls(toolbar);

		// Timeline Controls
		this._timelineControls = this.buildTimelineControls(toolbar);

		// Initial UI Update
		this.updateUI(this._mode);

		return toolbar;
	}

	private buildHeatmapControls(parent: HTMLElement) {
		const container = document.createElement('div');
		container.className = 'ren-graph-toolbar-heatmap';
		container.style.display = 'none';
		container.style.alignItems = 'center';
		container.style.gap = '6px';

		const granularityLabel = document.createElement('label');
		granularityLabel.className = 'ren-graph-toolbar-field';
		granularityLabel.textContent = 'Granularity: ';
		const granularitySelect = document.createElement('select');
		granularitySelect.className = 'ren-graph-toolbar-select';
		([['topLevel', 'Top folders'], ['twoLevel', 'Folder · Subfolder'], ['file', 'Individual files']] as const).forEach(([value, label]) => {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = label;
			granularitySelect.appendChild(option);
		});
		granularitySelect.value = this._heatmapGranularity;
		granularitySelect.addEventListener('change', () => {
			this.delegate.onGranularityChanged(granularitySelect.value as GitHeatmapGranularity);
		});
		granularityLabel.appendChild(granularitySelect);
		container.appendChild(granularityLabel);

		const windowLabel = document.createElement('label');
		windowLabel.className = 'ren-graph-toolbar-field';
		windowLabel.textContent = 'Window: ';
		const windowSelect = document.createElement('select');
		windowSelect.className = 'ren-graph-toolbar-select';
		([['60', '60 days'], ['90', '90 days'], ['120', '120 days'], ['180', '180 days']] as const).forEach(([value, label]) => {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = label;
			windowSelect.appendChild(option);
		});
		windowSelect.value = String(this._heatmapWindowDays);
		windowSelect.addEventListener('change', () => {
			const parsed = parseInt(windowSelect.value, 10);
			if (!Number.isNaN(parsed) && parsed > 0) {
				this.delegate.onWindowChanged(parsed);
			}
		});
		windowLabel.appendChild(windowSelect);
		container.appendChild(windowLabel);

		const summary = document.createElement('span');
		summary.className = 'ren-graph-toolbar-summary';
		summary.textContent = 'Coupling across recent commits.';
		container.appendChild(summary);

		parent.appendChild(container);

		return { container, granularitySelect, windowSelect, summary };
	}

	private buildTimelineControls(parent: HTMLElement) {
		const container = document.createElement('div');
		container.className = 'ren-graph-toolbar-timeline';
		container.style.display = 'none';
		container.style.alignItems = 'center';
		container.style.gap = '8px';
		container.style.flex = '1';

		const playButton = document.createElement('button');
		playButton.textContent = '▶';
		playButton.className = 'ren-graph-toolbar-btn';
		playButton.style.minWidth = '24px';
		playButton.onclick = () => this.delegate.onTimelineTogglePlay();
		
		const slider = document.createElement('input');
		slider.type = 'range';
		slider.min = '0';
		slider.max = '100';
		slider.value = '100';
		slider.style.flex = '1';
		slider.oninput = (e) => this.delegate.onTimelineSliderChanged(parseInt((e.target as HTMLInputElement).value, 10));

		const dateLabel = document.createElement('span');
		dateLabel.textContent = 'Now';
		dateLabel.style.fontSize = '12px';
		dateLabel.style.minWidth = '80px';
		dateLabel.style.textAlign = 'right';

		container.appendChild(playButton);
		container.appendChild(slider);
		container.appendChild(dateLabel);

		parent.appendChild(container);

		return { container, slider, playButton, dateLabel };
	}

	updateUI(mode: GraphMode, selectedFile?: URI, selectedFolder?: URI, selectedFunction?: FunctionDefinition): void {
		this._mode = mode;
		if (this._modeSelect) {
			this._isUpdatingProgrammatically = true;
			try {
				this._modeSelect.value = this._mode;
			} finally {
				setTimeout(() => {
					this._isUpdatingProgrammatically = false;
				}, 0);
			}
		}

		if (this._targetButton) {
			switch (this._mode) {
				case 'workspace':
					this._targetButton.textContent = 'Render Workspace';
					this._targetButton.title = 'Visualize dependencies for the entire workspace';
					break;
				case 'folder':
					this._targetButton.textContent = selectedFolder
						? 'Change source'
						: 'Select source';
					this._targetButton.title = 'Choose a folder to visualize';
					break;
				case 'gitHeatmap':
					this._targetButton.textContent = 'Refresh Heatmap';
					this._targetButton.title = 'Rebuild module co-change heatmap from Git history';
					break;
				case 'dataFlow':
					this._targetButton.textContent = selectedFunction
						? 'Change function'
						: 'Select function';
					this._targetButton.title = 'Choose a function to analyze data flow';
					break;
				case 'evolution':
					this._targetButton.textContent = 'Load History';
					this._targetButton.title = 'Load commit history for timeline';
					break;
				case 'changeImpact':
					this._targetButton.textContent = 'Refresh Impact';
					this._targetButton.title = 'Analyze impact of current draft';
					break;
				case 'file':
				default:
					this._targetButton.textContent = selectedFile
						? 'Change source'
						: 'Select source';
					this._targetButton.title = 'Choose a file to visualize';
					break;
			}
		}

		if (this._heatmapControls) {
			const visible = this._mode === 'gitHeatmap';
			this._heatmapControls.container.style.display = visible ? 'inline-flex' : 'none';
		}
		if (this._timelineControls) {
			this._timelineControls.container.style.display = this._mode === 'evolution' ? 'inline-flex' : 'none';
		}
	}

	updateHeatmapSummary(payload: GitHeatmapPayload | null): void {
		if (!this._heatmapControls) {
			return;
		}
		this._heatmapControls.summary.textContent = payload
			? this.buildHeatmapSummary(payload)
			: 'Coupling across recent commits.';
	}

	updateHeatmapHover(raw: unknown, latestHeatmap: GitHeatmapPayload | null): void {
		if (!latestHeatmap || !this._heatmapControls || !raw || typeof raw !== 'object') {
			return;
		}
		const hover = raw as { row?: unknown; column?: unknown; normalized?: unknown };
		if (typeof hover.row !== 'number' || typeof hover.column !== 'number') {
			return;
		}
		const moduleA = latestHeatmap.modules[hover.row] ?? `(row ${hover.row})`;
		const moduleB = latestHeatmap.modules[hover.column] ?? `(col ${hover.column})`;
		const score = typeof hover.normalized === 'number' ? hover.normalized : 0;
		this._heatmapControls.summary.textContent = `${moduleA} ↔ ${moduleB} · ${score.toFixed(2)}`;
	}

	setTimelinePlaying(playing: boolean): void {
		if (this._timelineControls) {
			this._timelineControls.playButton.textContent = playing ? '⏸' : '▶';
		}
	}

	setTimelineSliderValue(value: number): void {
		if (this._timelineControls) {
			this._timelineControls.slider.value = String(value);
		}
	}

	setTimelineDate(text: string): void {
		if (this._timelineControls) {
			this._timelineControls.dateLabel.textContent = text;
		}
	}

	private buildHeatmapSummary(payload: GitHeatmapPayload): string {
		const modules = payload.modules.length;
		const pairs = payload.cells.length;
		const windowDays = payload.windowDays;
		const peak = payload.colorScale.max;
		const roundedPeak = Number.isFinite(peak) && peak > 0 ? peak.toFixed(2) : '0';
		return `${modules} modules · ${pairs} pairs · ${windowDays}d · peak ${roundedPeak}`;
	}

	private getModeLabel(mode: GraphMode): string {
		switch (mode) {
			case 'file': return 'File Imports';
			case 'folder': return 'Folder Structure';
			case 'workspace': return 'Workspace Overview';
			case 'gitHeatmap': return 'Git Heatmap';
			case 'dataFlow': return 'Data Flow';
			case 'changeImpact': return 'Change Impact';
			case 'evolution': return 'Evolution Timeline';
			default: return mode;
		}
	}
}
