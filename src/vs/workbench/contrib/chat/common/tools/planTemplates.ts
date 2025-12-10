/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';

export interface PlanTemplate {
	id: string;
	name: string;
	description: string;
	category: 'feature' | 'bugfix' | 'refactor' | 'migration' | 'custom';
	content: string;
	variables?: Record<string, string>;
}

export interface PlanMetadata {
	title: string;
	author?: string;
	created?: string;
	lastUpdated?: string;
	status?: 'draft' | 'in-progress' | 'review' | 'approved' | 'executing' | 'completed';
	version?: string;
}

export const DEFAULT_PLAN_TEMPLATES: PlanTemplate[] = [
	{
		id: 'feature-development',
		name: localize('planTemplate.feature.name', 'Feature Development'),
		description: localize('planTemplate.feature.description', 'Template for developing new features'),
		category: 'feature',
		content: `# {{title}}

## Metadata
- **Author**: {{author}}
- **Created**: {{created}}
- **Status**: {{status}}
- **Version**: {{version}}

## Goal
Brief summary of what is being built.

## Requirements
- Requirement 1
- Requirement 2
- Requirement 3

## Architecture
High-level description of the architectural approach.

### Components
- Component 1
- Component 2

## Implementation Steps

### Step 1: [Description]
- [ ] Task 1
- [ ] Task 2

### Step 2: [Description]
- [ ] Task 1
- [ ] Task 2

## Testing Strategy
- Unit tests
- Integration tests
- Manual testing

## Verification
How to verify the implementation is complete and correct.

## Rollout Plan
- Phase 1: [Description]
- Phase 2: [Description]
`,
		variables: {
			title: 'Feature Name',
			author: 'Developer',
			created: new Date().toISOString().split('T')[0],
			status: 'draft',
			version: '1.0.0'
		}
	},
	{
		id: 'bug-fix',
		name: localize('planTemplate.bugfix.name', 'Bug Fix'),
		description: localize('planTemplate.bugfix.description', 'Template for fixing bugs'),
		category: 'bugfix',
		content: `# Bug Fix: {{title}}

## Metadata
- **Author**: {{author}}
- **Created**: {{created}}
- **Status**: {{status}}
- **Version**: {{version}}

## Problem Description
Detailed description of the bug.

## Root Cause Analysis
- Investigation findings
- Root cause identified

## Solution Approach
Description of the fix approach.

## Implementation Steps
- [ ] Step 1: [Description]
- [ ] Step 2: [Description]
- [ ] Step 3: [Description]

## Testing
- [ ] Reproduce the bug
- [ ] Verify fix resolves the issue
- [ ] Regression testing
- [ ] Edge case testing

## Verification
How to verify the bug is fixed.

## Related Issues
- Issue #1
- Issue #2
`,
		variables: {
			title: 'Bug Description',
			author: 'Developer',
			created: new Date().toISOString().split('T')[0],
			status: 'draft',
			version: '1.0.0'
		}
	},
	{
		id: 'refactoring',
		name: localize('planTemplate.refactor.name', 'Refactoring'),
		description: localize('planTemplate.refactor.description', 'Template for code refactoring'),
		category: 'refactor',
		content: `# Refactoring: {{title}}

## Metadata
- **Author**: {{author}}
- **Created**: {{created}}
- **Status**: {{status}}
- **Version**: {{version}}

## Goal
What we want to achieve with this refactoring.

## Current State
Description of the current code structure.

## Target State
Description of the desired code structure.

## Refactoring Strategy
- Strategy 1
- Strategy 2

## Affected Files
- file1.ts
- file2.ts

## Implementation Steps
- [ ] Step 1: [Description]
- [ ] Step 2: [Description]
- [ ] Step 3: [Description]

## Testing Strategy
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] No regression

## Verification
How to verify the refactoring is successful.
`,
		variables: {
			title: 'Refactoring Description',
			author: 'Developer',
			created: new Date().toISOString().split('T')[0],
			status: 'draft',
			version: '1.0.0'
		}
	},
	{
		id: 'migration',
		name: localize('planTemplate.migration.name', 'Migration'),
		description: localize('planTemplate.migration.description', 'Template for system migrations'),
		category: 'migration',
		content: `# Migration: {{title}}

## Metadata
- **Author**: {{author}}
- **Created**: {{created}}
- **Status**: {{status}}
- **Version**: {{version}}

## Goal
What we are migrating from and to.

## Migration Scope
- Component 1
- Component 2

## Migration Strategy
- Phase 1: [Description]
- Phase 2: [Description]
- Phase 3: [Description]

## Implementation Steps
- [ ] Step 1: [Description]
- [ ] Step 2: [Description]
- [ ] Step 3: [Description]

## Rollback Plan
What to do if migration fails.

## Testing Strategy
- Pre-migration testing
- Post-migration testing
- Validation

## Verification
How to verify the migration is successful.
`,
		variables: {
			title: 'Migration Description',
			author: 'Developer',
			created: new Date().toISOString().split('T')[0],
			status: 'draft',
			version: '1.0.0'
		}
	}
];

/**
 * Substitute template variables in plan content
 */
export function substituteTemplateVariables(content: string, variables: Record<string, string>): string {
	let result = content;
	for (const [key, value] of Object.entries(variables)) {
		const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
		result = result.replace(regex, value);
	}
	return result;
}

/**
 * Get template by ID
 */
export function getTemplateById(id: string): PlanTemplate | undefined {
	return DEFAULT_PLAN_TEMPLATES.find(t => t.id === id);
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(category: PlanTemplate['category']): PlanTemplate[] {
	return DEFAULT_PLAN_TEMPLATES.filter(t => t.category === category);
}

/**
 * Parse plan metadata from markdown content
 */
export function parsePlanMetadata(content: string): PlanMetadata | null {
	const metadataRegex = /## Metadata\s*\n([\s\S]*?)(?=\n## |$)/;
	const match = content.match(metadataRegex);
	if (!match) {
		return null;
	}

	const metadata: PlanMetadata = {
		title: extractTitle(content) || 'Untitled Plan'
	};

	const metadataSection = match[1];
	const titleMatch = content.match(/^#\s+(.+)$/m);
	if (titleMatch) {
		metadata.title = titleMatch[1].trim();
	}

	// Extract metadata fields
	const authorMatch = metadataSection.match(/\*\*Author\*\*:\s*(.+)/);
	if (authorMatch) {
		metadata.author = authorMatch[1].trim();
	}

	const createdMatch = metadataSection.match(/\*\*Created\*\*:\s*(.+)/);
	if (createdMatch) {
		metadata.created = createdMatch[1].trim();
	}

	const lastUpdatedMatch = metadataSection.match(/\*\*Last Updated\*\*:\s*(.+)/);
	if (lastUpdatedMatch) {
		metadata.lastUpdated = lastUpdatedMatch[1].trim();
	}

	const statusMatch = metadataSection.match(/\*\*Status\*\*:\s*(.+)/);
	if (statusMatch) {
		const status = statusMatch[1].trim().toLowerCase();
		if (['draft', 'in-progress', 'review', 'approved', 'executing', 'completed'].includes(status)) {
			metadata.status = status as PlanMetadata['status'];
		}
	}

	const versionMatch = metadataSection.match(/\*\*Version\*\*:\s*(.+)/);
	if (versionMatch) {
		metadata.version = versionMatch[1].trim();
	}

	return metadata;
}

/**
 * Extract title from markdown content
 */
function extractTitle(content: string): string | null {
	const titleMatch = content.match(/^#\s+(.+)$/m);
	return titleMatch ? titleMatch[1].trim() : null;
}

/**
 * Generate plan content from template
 */
export function generatePlanFromTemplate(templateId: string, variables?: Record<string, string>): string {
	const template = getTemplateById(templateId);
	if (!template) {
		throw new Error(`Template not found: ${templateId}`);
	}

	const mergedVariables = { ...template.variables, ...variables };
	return substituteTemplateVariables(template.content, mergedVariables);
}

