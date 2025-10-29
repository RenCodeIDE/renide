/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IRenView } from './renView.interface.js';

interface GraphBlock {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	element: HTMLElement;
}

export class GraphView extends Disposable implements IRenView {
	private _mainContainer: HTMLElement | null = null;
	private _canvas: HTMLElement | null = null;
	private _blocks: Map<string, GraphBlock> = new Map();
	private _isPanning: boolean = false;
	private _panStartX: number = 0;
	private _panStartY: number = 0;
	private _translateX: number = 0;
	private _translateY: number = 0;
	private _window: Window | null = null;

	show(contentArea: HTMLElement): void {
		// Clear existing content safely
		contentArea.textContent = '';

		// Store window reference
		this._window = getWindow(contentArea);

		// Create main container
		this._mainContainer = document.createElement('div');
		this._mainContainer.className = 'ren-graph-container';

		// Create title
		const title = document.createElement('h2');
		title.textContent = 'Graph View';
		title.className = 'ren-graph-title';

		// Create canvas container
		this._canvas = document.createElement('div');
		this._canvas.className = 'ren-graph-canvas';
		this._canvas.id = 'ren-graph-canvas';

		this._mainContainer.appendChild(title);
		this._mainContainer.appendChild(this._canvas);
		contentArea.appendChild(this._mainContainer);

		// Initialize canvas interactions
		this.initializeCanvas();

		// Create initial blocks
		this.createInitialBlocks();
	}

	private initializeCanvas(): void {
		if (!this._canvas) {
			return;
		}

		// Pan on middle mouse button or space + drag
		this._canvas.addEventListener('mousedown', (e) => {
			if (e.button === 1 || (e.button === 0 && e.ctrlKey)) { // Middle mouse or Ctrl+Left
				this._isPanning = true;
				this._panStartX = e.clientX - this._translateX;
				this._panStartY = e.clientY - this._translateY;
				this._canvas!.style.cursor = 'grabbing';
				e.preventDefault();
			}
		});

		this._canvas.addEventListener('mousemove', (e) => {
			if (this._isPanning) {
				this._translateX = e.clientX - this._panStartX;
				this._translateY = e.clientY - this._panStartY;
				this._canvas!.style.transform = `translate(${this._translateX}px, ${this._translateY}px)`;
			}
		});

		this._window?.document.addEventListener('mouseup', () => {
			if (this._isPanning) {
				this._isPanning = false;
				if (this._canvas) {
					this._canvas.style.cursor = 'default';
				}
			}
		});

		// Zoom with wheel
		this._canvas.addEventListener('wheel', (e) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				const delta = e.deltaY > 0 ? 0.9 : 1.1;
				const currentScale = parseFloat(this._canvas!.style.transform.split('scale(')[1]?.split(')')[0] || '1');
				const newScale = Math.max(0.1, Math.min(3, currentScale * delta));
				this._canvas!.style.transform = `translate(${this._translateX}px, ${this._translateY}px) scale(${newScale})`;
			}
		});
	}

	private createInitialBlocks(): void {
		if (!this._canvas) {
			return;
		}

		const blockTypes = [
			{ name: 'Input', color: '#4EC9B0' },
			{ name: 'Process', color: '#569CD6' },
			{ name: 'Output', color: '#D7BA7D' },
			{ name: 'Data', color: '#C586C0' },
			{ name: 'Transform', color: '#CE9178' }
		];

		blockTypes.forEach((type, index) => {
			const block = this.createBlock(
				type.name,
				200 + index * 180,
				150 + index * 100,
				120,
				80,
				type.color
			);
			this._blocks.set(block.id, block);
		});
	}

	private createBlock(name: string, x: number, y: number, width: number, height: number, color: string): GraphBlock {
		if (!this._canvas) {
			throw new Error('Canvas not initialized');
		}

		const blockId = `block-${Date.now()}-${Math.random()}`;
		const blockElement = document.createElement('div');
		blockElement.className = 'ren-graph-block';
		blockElement.style.left = `${x}px`;
		blockElement.style.top = `${y}px`;
		blockElement.style.width = `${width}px`;
		blockElement.style.height = `${height}px`;
		blockElement.style.backgroundColor = color;
		blockElement.textContent = name;
		blockElement.draggable = true;

		// Make block draggable
		let isDragging = false;
		let startX = 0;
		let startY = 0;

		blockElement.addEventListener('mousedown', (e) => {
			if (e.button === 0 && !e.ctrlKey) { // Left mouse without Ctrl
				isDragging = true;
				startX = e.clientX - x;
				startY = e.clientY - y;
				e.preventDefault();
			}
		});

		const window = getWindow(blockElement);
		window.document.addEventListener('mousemove', (e) => {
			if (isDragging) {
				const newX = e.clientX - startX;
				const newY = e.clientY - startY;
				blockElement.style.left = `${newX}px`;
				blockElement.style.top = `${newY}px`;
			}
		});

		window.document.addEventListener('mouseup', () => {
			if (isDragging) {
				isDragging = false;
			}
		});

		// Add hover effect
		blockElement.addEventListener('mouseenter', () => {
			blockElement.style.transform = 'scale(1.05)';
			blockElement.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
		});

		blockElement.addEventListener('mouseleave', () => {
			blockElement.style.transform = 'scale(1)';
			blockElement.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
		});

		this._canvas.appendChild(blockElement);

		const block: GraphBlock = {
			id: blockId,
			x,
			y,
			width,
			height,
			element: blockElement
		};

		return block;
	}

	hide(): void {
		if (this._mainContainer) {
			this._mainContainer.remove();
			this._mainContainer = null;
			this._canvas = null;
			this._blocks.clear();
			this._translateX = 0;
			this._translateY = 0;
		}
	}
}
