/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { parsePlanMetadata } from './tools/planTemplates.js';

export interface PlanValidationError {
	type: 'missing-section' | 'invalid-format' | 'missing-todos' | 'invalid-metadata' | 'file-reference';
	section?: string;
	message: string;
	severity: 'error' | 'warning';
}

export interface PlanValidationResult {
	isValid: boolean;
	errors: PlanValidationError[];
	warnings: PlanValidationError[];
	score: number; // 0-100 quality score
	suggestions: string[];
}

export class PlanValidator {
	constructor(
		@IFileService private readonly fileService: IFileService
	) { }

	/**
	 * Validate a plan file
	 */
	async validatePlan(planContent: string, planUri?: URI): Promise<PlanValidationResult> {
		const errors: PlanValidationError[] = [];
		const warnings: PlanValidationError[] = [];
		const suggestions: string[] = [];

		// Check for required sections
		const requiredSections = ['Goal', 'Implementation Steps'];
		for (const section of requiredSections) {
			if (!this.hasSection(planContent, section)) {
				errors.push({
					type: 'missing-section',
					section,
					message: `Missing required section: ${section}`,
					severity: 'error'
				});
			}
		}

		// Check for optional but recommended sections
		const recommendedSections = ['Requirements', 'Architecture', 'Testing Strategy', 'Verification'];
		for (const section of recommendedSections) {
			if (!this.hasSection(planContent, section)) {
				warnings.push({
					type: 'missing-section',
					section,
					message: `Missing recommended section: ${section}`,
					severity: 'warning'
				});
				suggestions.push(`Consider adding a "${section}" section to make your plan more comprehensive.`);
			}
		}

		// Check for todos in Implementation Steps
		const hasTodos = this.hasTodos(planContent);
		if (!hasTodos) {
			warnings.push({
				type: 'missing-todos',
				message: 'No todos found in Implementation Steps. Consider adding actionable todos.',
				severity: 'warning'
			});
			suggestions.push('Add todos (checkboxes) to your Implementation Steps to track progress.');
		}

		// Validate metadata
		const metadata = parsePlanMetadata(planContent);
		if (!metadata) {
			warnings.push({
				type: 'invalid-metadata',
				message: 'No metadata section found. Consider adding metadata for better plan tracking.',
				severity: 'warning'
			});
		} else {
			if (!metadata.status) {
				warnings.push({
					type: 'invalid-metadata',
					message: 'Metadata missing status field.',
					severity: 'warning'
				});
			}
		}

		// Check for file references (if planUri is provided)
		if (planUri) {
			const fileReferences = this.extractFileReferences(planContent);
			for (const fileRef of fileReferences) {
				const fileExists = await this.checkFileExists(planUri, fileRef);
				if (!fileExists) {
					warnings.push({
						type: 'file-reference',
						message: `Referenced file may not exist: ${fileRef}`,
						severity: 'warning'
					});
				}
			}
		}

		// Calculate quality score
		const score = this.calculateQualityScore(planContent, errors, warnings);

		return {
			isValid: errors.length === 0,
			errors,
			warnings,
			score,
			suggestions
		};
	}

	/**
	 * Check if plan has a specific section
	 */
	private hasSection(content: string, sectionName: string): boolean {
		const regex = new RegExp(`^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
		return regex.test(content);
	}

	/**
	 * Check if plan has todos
	 */
	private hasTodos(content: string): boolean {
		const todoRegex = /-?\s*\[[\sx]\]/i;
		return todoRegex.test(content);
	}

	/**
	 * Extract file references from plan content
	 */
	private extractFileReferences(content: string): string[] {
		const fileRefs: string[] = [];
		// Match common file reference patterns
		const patterns = [
			/`([^`]+\.(ts|js|tsx|jsx|py|java|cpp|h|hpp|md|json|yaml|yml))`/g,
			/\[([^\]]+\.(ts|js|tsx|jsx|py|java|cpp|h|hpp|md|json|yaml|yml))\]/g,
			/file:\s*([^\s]+)/gi
		];

		for (const pattern of patterns) {
			let match;
			while ((match = pattern.exec(content)) !== null) {
				fileRefs.push(match[1]);
			}
		}

		return [...new Set(fileRefs)]; // Remove duplicates
	}

	/**
	 * Check if a file exists relative to plan file
	 */
	private async checkFileExists(planUri: URI, filePath: string): Promise<boolean> {
		try {
			// Resolve relative to plan file directory
			const planDir = planUri.with({ path: planUri.path.substring(0, planUri.path.lastIndexOf('/')) });
			const fileUri = planDir.with({ path: `${planDir.path}/${filePath}` });
			return await this.fileService.exists(fileUri);
		} catch {
			return false;
		}
	}

	/**
	 * Calculate quality score (0-100)
	 */
	private calculateQualityScore(content: string, errors: PlanValidationError[], warnings: PlanValidationError[]): number {
		let score = 100;

		// Deduct points for errors
		score -= errors.length * 20;

		// Deduct points for warnings
		score -= warnings.length * 5;

		// Bonus for having todos
		if (this.hasTodos(content)) {
			score += 5;
		}

		// Bonus for having metadata
		if (parsePlanMetadata(content)) {
			score += 5;
		}

		// Bonus for having recommended sections
		const recommendedSections = ['Requirements', 'Architecture', 'Testing Strategy', 'Verification'];
		const hasRecommended = recommendedSections.filter(section => this.hasSection(content, section)).length;
		score += hasRecommended * 5;

		return Math.max(0, Math.min(100, score));
	}

	/**
	 * Get validation summary message
	 */
	getValidationSummary(result: PlanValidationResult): string {
		if (result.isValid && result.warnings.length === 0) {
			return `Plan is valid (Quality Score: ${result.score}/100)`;
		}

		const parts: string[] = [];
		if (!result.isValid) {
			parts.push(`${result.errors.length} error(s)`);
		}
		if (result.warnings.length > 0) {
			parts.push(`${result.warnings.length} warning(s)`);
		}
		parts.push(`Quality Score: ${result.score}/100`);

		return parts.join(', ');
	}
}

