/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { GraphWorkspaceContext } from './graphContext.js';
import { ArchitectureAnalyzer, ArchitectureAnalysisResult } from './architectureAnalyzer.js';

/**
 * The type of codebase detected in the workspace
 */
export type CodebaseType = 'frontend' | 'backend' | 'fullstack' | 'library' | 'cli' | 'monorepo' | 'unknown';

/**
 * Detected features within the codebase
 */
export interface CodebaseFeatures {
	// Frontend indicators
	hasRouting: boolean;
	hasStateManagement: boolean;
	hasUIComponents: boolean;
	hasStyling: boolean;
	hasClientSideRendering: boolean;
	hasServerSideRendering: boolean;

	// Backend indicators
	hasApiRoutes: boolean;
	hasDatabase: boolean;
	hasAuthentication: boolean;
	hasMiddleware: boolean;
	hasORMUsage: boolean;

	// Shared indicators
	hasTests: boolean;
	hasMonorepoStructure: boolean;
	hasSharedPackages: boolean;
	hasDockerConfig: boolean;
}

/**
 * Detected framework information
 */
export interface FrameworkInfo {
	id: string;
	name: string;
	type: 'frontend' | 'backend' | 'fullstack' | 'tool';
	confidence: number;
	version?: string;
}

/**
 * Complete codebase profile
 */
export interface CodebaseProfile {
	type: CodebaseType;
	confidence: number;
	primaryFramework: FrameworkInfo | null;
	frameworks: FrameworkInfo[];
	features: CodebaseFeatures;
	detectedPatterns: string[];
	summary: string;
	recommendations: string[];
}

/**
 * Frontend-specific analysis result
 */
export interface FrontendAnalysis {
	framework: FrameworkInfo | null;
	routingType: 'file-based' | 'config-based' | 'none';
	stateManagement: string[];
	uiLibraries: string[];
	hasSSR: boolean;
	hasSSG: boolean;
}

/**
 * Backend-specific analysis result
 */
export interface BackendAnalysis {
	framework: FrameworkInfo | null;
	routeCount: number;
	hasControllers: boolean;
	hasServices: boolean;
	hasRepositories: boolean;
	databases: string[];
	ormUsed: string | null;
}

/**
 * Maps framework technology names to their types
 */
const FRAMEWORK_TYPE_MAP: Record<string, 'frontend' | 'backend' | 'fullstack' | 'tool'> = {
	// Frontend frameworks
	'React': 'frontend',
	'Vue.js': 'frontend',
	'Angular': 'frontend',
	'Svelte': 'frontend',
	'Vite': 'tool',

	// Full-stack frameworks (SSR/SSG capable)
	'Next.js': 'fullstack',
	'Nuxt.js': 'fullstack',
	'Remix': 'fullstack',

	// Backend frameworks
	'Express.js': 'backend',
	'Fastify': 'backend',
	'NestJS': 'backend',
	'Koa': 'backend',
	'hapi': 'backend',
	'Hono': 'backend',
	'tRPC': 'backend',
	'AdonisJS': 'backend',
	'Apollo GraphQL': 'backend',

	// Python backends
	'Django': 'backend',
	'FastAPI': 'backend',
	'Flask': 'backend',
	'Tornado': 'backend',
	'Celery Worker': 'backend',

	// Go backends
	'Gin': 'backend',
	'Echo': 'backend',
	'Fiber': 'backend',
};

/**
 * State management libraries
 */
const STATE_MANAGEMENT_LIBS = new Set([
	'redux', '@reduxjs/toolkit', 'zustand', 'jotai', 'recoil', 'mobx',
	'xstate', 'valtio', '@tanstack/react-query', 'swr', 'pinia', 'vuex', 'ngrx'
]);

/**
 * Routing libraries
 */
const ROUTING_LIBS = new Set([
	'react-router', 'react-router-dom', '@reach/router', 'wouter',
	'vue-router', '@angular/router'
]);

/**
 * UI component libraries
 */
const UI_LIBS = new Set([
	'@mui/material', '@chakra-ui/react', 'antd', '@radix-ui/react-dialog',
	'@headlessui/react', 'tailwindcss', 'styled-components', '@emotion/react',
	'primereact', 'vuetify', 'quasar', '@angular/material'
]);

/**
 * Codebase Type Detector
 *
 * Analyzes the workspace to determine if it's a frontend, backend, or full-stack project.
 * Uses results from ArchitectureAnalyzer and adds additional heuristics for classification.
 */
export class CodebaseTypeDetector {
	private cachedProfile: CodebaseProfile | undefined;
	private cacheTimestamp = 0;
	private readonly cacheTtlMs = 5 * 60 * 1000; // 5 minutes

	constructor(
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly context: GraphWorkspaceContext,
		private readonly architectureAnalyzer: ArchitectureAnalyzer
	) { }

	/**
	 * Analyze the workspace and return a complete codebase profile
	 */
	async analyze(force = false): Promise<CodebaseProfile> {
		if (!force && this.cachedProfile && Date.now() - this.cacheTimestamp < this.cacheTtlMs) {
			return this.cachedProfile;
		}

		this.logService.info('[CodebaseTypeDetector] Starting codebase analysis...');

		// Get architecture analysis results
		const archResult = await this.architectureAnalyzer.analyze({ force });

		// Extract frameworks from architecture components
		const frameworks = this.extractFrameworks(archResult);

		// Detect features
		const features = await this.detectFeatures(archResult);

		// Determine codebase type
		const { type, confidence } = await this.determineCodebaseType(archResult, frameworks, features);

		// Find primary framework
		const primaryFramework = this.findPrimaryFramework(frameworks, type);

		// Detect patterns
		const detectedPatterns = this.detectPatterns(archResult, frameworks, features);

		// Generate summary
		const summary = this.generateSummary(type, primaryFramework, frameworks, features);

		// Generate recommendations
		const recommendations = this.generateRecommendations(type, features, detectedPatterns);

		const profile: CodebaseProfile = {
			type,
			confidence,
			primaryFramework,
			frameworks,
			features,
			detectedPatterns,
			summary,
			recommendations
		};

		this.logService.info(`[CodebaseTypeDetector] Analysis complete: ${type} (${(confidence * 100).toFixed(1)}% confidence)`);
		this.logService.debug('[CodebaseTypeDetector] Profile:', JSON.stringify(profile, null, 2));

		this.cachedProfile = profile;
		this.cacheTimestamp = Date.now();

		return profile;
	}

	/**
	 * Extract framework information from architecture components
	 */
	private extractFrameworks(archResult: ArchitectureAnalysisResult): FrameworkInfo[] {
		const frameworks: FrameworkInfo[] = [];
		const seen = new Set<string>();

		for (const component of archResult.components) {
			if (component.technology && !seen.has(component.technology)) {
				seen.add(component.technology);
				const frameworkType = FRAMEWORK_TYPE_MAP[component.technology] ?? 'tool';

				frameworks.push({
					id: component.key,
					name: component.technology,
					type: frameworkType,
					confidence: component.confidence
				});
			}
		}

		return frameworks.sort((a, b) => b.confidence - a.confidence);
	}

	/**
	 * Detect codebase features from architecture and file analysis
	 */
	private async detectFeatures(archResult: ArchitectureAnalysisResult): Promise<CodebaseFeatures> {
		const components = archResult.components;

		// Count component types
		const frontendCount = components.filter(c => c.kind === 'frontend').length;
		const backendCount = components.filter(c => c.kind === 'backend').length;
		const databaseCount = components.filter(c => c.kind === 'database').length;

		// Check for specific technologies in metadata
		const allTechnologies = new Set(components.map(c => c.technology?.toLowerCase()).filter(Boolean));
		const allTags = new Set(components.flatMap(c => c.tags));

		// Detect state management
		const hasStateManagement = this.checkForDependencies(archResult, STATE_MANAGEMENT_LIBS);

		// Detect routing
		const hasRouting = this.checkForDependencies(archResult, ROUTING_LIBS) ||
			allTechnologies.has('next.js') || allTechnologies.has('nuxt.js');

		// Detect UI components
		const hasUIComponents = this.checkForDependencies(archResult, UI_LIBS) ||
			frontendCount > 0;

		// Detect styling
		const hasStyling = this.checkForDependencies(archResult, new Set(['tailwindcss', 'sass', 'less', 'styled-components', '@emotion/react']));

		// Detect SSR/SSG
		const hasSSR = allTechnologies.has('next.js') || allTechnologies.has('nuxt.js') || allTechnologies.has('remix');
		const hasCSR = frontendCount > 0 && !hasSSR;

		// Backend features
		const hasApiRoutes = backendCount > 0;
		const hasDatabase = databaseCount > 0;
		const hasMiddleware = allTags.has('middleware') || allTechnologies.has('express.js');
		const hasAuth = this.checkForDependencies(archResult, new Set(['passport', 'jsonwebtoken', 'bcrypt', '@auth/core', 'next-auth']));
		const hasORM = this.checkForDependencies(archResult, new Set(['prisma', '@prisma/client', 'typeorm', 'sequelize', 'drizzle-orm', 'mongoose']));

		// Infrastructure
		const hasDocker = archResult.components.some(c => c.kind === 'infrastructure');
		const hasMonorepo = await this.detectMonorepoStructure();

		return {
			hasRouting,
			hasStateManagement,
			hasUIComponents,
			hasStyling,
			hasClientSideRendering: hasCSR,
			hasServerSideRendering: hasSSR,
			hasApiRoutes,
			hasDatabase,
			hasAuthentication: hasAuth,
			hasMiddleware,
			hasORMUsage: hasORM,
			hasTests: await this.detectTests(),
			hasMonorepoStructure: hasMonorepo,
			hasSharedPackages: await this.detectSharedPackages(),
			hasDockerConfig: hasDocker
		};
	}

	/**
	 * Check if any of the specified dependencies are present
	 */
	private checkForDependencies(archResult: ArchitectureAnalysisResult, deps: Set<string>): boolean {
		for (const component of archResult.components) {
			for (const evidence of component.evidence) {
				if (evidence.snippet) {
					const depArray = Array.from(deps);
					for (const dep of depArray) {
						if (evidence.snippet.includes(`"${dep}"`)) {
							return true;
						}
					}
				}
			}
		}
		return false;
	}

	/**
	 * Determine the codebase type based on all collected information
	 */
	private async determineCodebaseType(
		archResult: ArchitectureAnalysisResult,
		frameworks: FrameworkInfo[],
		features: CodebaseFeatures
	): Promise<{ type: CodebaseType; confidence: number }> {
		const frontendComponents = archResult.components.filter(c => c.kind === 'frontend');
		const backendComponents = archResult.components.filter(c => c.kind === 'backend');

		const hasFrontend = frontendComponents.length > 0 || features.hasUIComponents;
		const hasBackend = backendComponents.length > 0 || features.hasApiRoutes;

		// Check for monorepo first
		if (features.hasMonorepoStructure) {
			return { type: 'monorepo', confidence: 0.85 };
		}

		// Check for fullstack frameworks
		const fullstackFramework = frameworks.find(f => f.type === 'fullstack');
		if (fullstackFramework) {
			// Next.js/Nuxt with API routes is fullstack
			if (features.hasApiRoutes || features.hasDatabase) {
				return { type: 'fullstack', confidence: fullstackFramework.confidence };
			}
			// Otherwise treat as frontend
			return { type: 'frontend', confidence: fullstackFramework.confidence };
		}

		// Both frontend and backend components
		if (hasFrontend && hasBackend) {
			const feConfidence = frontendComponents.reduce((sum, c) => sum + c.confidence, 0) / Math.max(1, frontendComponents.length);
			const beConfidence = backendComponents.reduce((sum, c) => sum + c.confidence, 0) / Math.max(1, backendComponents.length);
			return { type: 'fullstack', confidence: (feConfidence + beConfidence) / 2 };
		}

		// Only backend
		if (hasBackend) {
			const avgConfidence = backendComponents.reduce((sum, c) => sum + c.confidence, 0) / Math.max(1, backendComponents.length);
			return { type: 'backend', confidence: avgConfidence };
		}

		// Only frontend
		if (hasFrontend) {
			const avgConfidence = frontendComponents.reduce((sum, c) => sum + c.confidence, 0) / Math.max(1, frontendComponents.length);
			return { type: 'frontend', confidence: avgConfidence };
		}

		// Check if it looks like a library (no app, just exports)
		if (await this.detectLibraryStructure()) {
			return { type: 'library', confidence: 0.6 };
		}

		return { type: 'unknown', confidence: 0.3 };
	}

	/**
	 * Find the primary framework based on type and confidence
	 */
	private findPrimaryFramework(frameworks: FrameworkInfo[], codebaseType: CodebaseType): FrameworkInfo | null {
		if (frameworks.length === 0) {
			return null;
		}

		// For fullstack, prefer fullstack frameworks
		if (codebaseType === 'fullstack') {
			const fullstackFramework = frameworks.find(f => f.type === 'fullstack');
			if (fullstackFramework) {
				return fullstackFramework;
			}
		}

		// For frontend, prefer frontend frameworks
		if (codebaseType === 'frontend') {
			const frontendFramework = frameworks.find(f => f.type === 'frontend' || f.type === 'fullstack');
			if (frontendFramework) {
				return frontendFramework;
			}
		}

		// For backend, prefer backend frameworks
		if (codebaseType === 'backend') {
			const backendFramework = frameworks.find(f => f.type === 'backend');
			if (backendFramework) {
				return backendFramework;
			}
		}

		// Return highest confidence framework
		return frameworks[0];
	}

	/**
	 * Detect architectural patterns
	 */
	private detectPatterns(
		archResult: ArchitectureAnalysisResult,
		frameworks: FrameworkInfo[],
		features: CodebaseFeatures
	): string[] {
		const patterns: string[] = [];

		// MVC pattern
		if (features.hasApiRoutes && this.hasLayeredStructure(archResult)) {
			patterns.push('MVC');
		}

		// Microservices (multiple backends)
		const backendCount = archResult.components.filter(c => c.kind === 'backend').length;
		if (backendCount > 2 || features.hasDockerConfig) {
			patterns.push('Microservices');
		}

		// Monolithic (single backend with database)
		if (backendCount === 1 && features.hasDatabase) {
			patterns.push('Monolithic');
		}

		// Component-based (React/Vue/Angular)
		if (frameworks.some(f => ['React', 'Vue.js', 'Angular'].includes(f.name))) {
			patterns.push('Component-Based Architecture');
		}

		// Server-Side Rendering
		if (features.hasServerSideRendering) {
			patterns.push('SSR');
		}

		// API-first
		if (features.hasApiRoutes && frameworks.some(f => f.name.includes('GraphQL') || f.name === 'tRPC')) {
			patterns.push('API-First');
		}

		return patterns;
	}

	/**
	 * Check if the codebase has a layered structure (controllers/services/repositories)
	 */
	private hasLayeredStructure(archResult: ArchitectureAnalysisResult): boolean {
		const tags = new Set(archResult.components.flatMap(c => c.tags));
		return tags.has('controller') || tags.has('service') || tags.has('repository');
	}

	/**
	 * Detect if the workspace is a monorepo
	 */
	private async detectMonorepoStructure(): Promise<boolean> {
		const workspaceFolders = this.context.getWorkspaceFolders();
		if (workspaceFolders.length === 0) {
			return false;
		}

		const rootUri = workspaceFolders[0].uri;

		// Check for common monorepo indicators
		const monorepoFiles = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json'];

		for (const file of monorepoFiles) {
			try {
				await this.fileService.readFile(this.context.extUri.joinPath(rootUri, file));
				return true;
			} catch { /* file doesn't exist */ }
		}

		// Check for packages/apps directory structure
		try {
			const packagesUri = this.context.extUri.joinPath(rootUri, 'packages');
			const stat = await this.fileService.stat(packagesUri);
			if (stat.isDirectory) {
				return true;
			}
		} catch { /* doesn't exist */ }

		try {
			const appsUri = this.context.extUri.joinPath(rootUri, 'apps');
			const stat = await this.fileService.stat(appsUri);
			if (stat.isDirectory) {
				return true;
			}
		} catch { /* doesn't exist */ }

		return false;
	}

	/**
	 * Detect if the workspace has a shared packages structure
	 */
	private async detectSharedPackages(): Promise<boolean> {
		const workspaceFolders = this.context.getWorkspaceFolders();
		if (workspaceFolders.length === 0) {
			return false;
		}

		const rootUri = workspaceFolders[0].uri;
		const sharedDirs = ['shared', 'common', 'libs', 'packages'];

		for (const dir of sharedDirs) {
			try {
				const dirUri = this.context.extUri.joinPath(rootUri, dir);
				const stat = await this.fileService.stat(dirUri);
				if (stat.isDirectory) {
					return true;
				}
			} catch { /* doesn't exist */ }
		}

		return false;
	}

	/**
	 * Detect if tests are present
	 */
	private async detectTests(): Promise<boolean> {
		const workspaceFolders = this.context.getWorkspaceFolders();
		if (workspaceFolders.length === 0) {
			return false;
		}

		const rootUri = workspaceFolders[0].uri;
		const testDirs = ['test', 'tests', '__tests__', 'spec', 'specs'];

		for (const dir of testDirs) {
			try {
				const dirUri = this.context.extUri.joinPath(rootUri, dir);
				const stat = await this.fileService.stat(dirUri);
				if (stat.isDirectory) {
					return true;
				}
			} catch { /* doesn't exist */ }
		}

		return false;
	}

	/**
	 * Detect if the codebase looks like a library (npm package)
	 */
	private async detectLibraryStructure(): Promise<boolean> {
		const workspaceFolders = this.context.getWorkspaceFolders();
		if (workspaceFolders.length === 0) {
			return false;
		}

		const rootUri = workspaceFolders[0].uri;

		try {
			const packageJsonUri = this.context.extUri.joinPath(rootUri, 'package.json');
			const content = await this.fileService.readFile(packageJsonUri);
			const manifest = JSON.parse(content.value.toString());

			// Libraries typically have main/module/exports and no scripts.start
			if ((manifest.main || manifest.module || manifest.exports) && !manifest.scripts?.start) {
				return true;
			}
		} catch { /* doesn't exist or can't parse */ }

		return false;
	}

	/**
	 * Generate a human-readable summary
	 */
	private generateSummary(
		type: CodebaseType,
		primaryFramework: FrameworkInfo | null,
		frameworks: FrameworkInfo[],
		features: CodebaseFeatures
	): string {
		const parts: string[] = [];

		switch (type) {
			case 'frontend':
				parts.push('This is a frontend application');
				break;
			case 'backend':
				parts.push('This is a backend/API application');
				break;
			case 'fullstack':
				parts.push('This is a full-stack application');
				break;
			case 'monorepo':
				parts.push('This is a monorepo with multiple packages');
				break;
			case 'library':
				parts.push('This is a library/package');
				break;
			default:
				parts.push('This codebase type could not be determined');
		}

		if (primaryFramework) {
			parts.push(`built with ${primaryFramework.name}`);
		}

		const featureDescriptions: string[] = [];
		if (features.hasServerSideRendering) featureDescriptions.push('SSR');
		if (features.hasStateManagement) featureDescriptions.push('state management');
		if (features.hasDatabase) featureDescriptions.push('database integration');
		if (features.hasAuthentication) featureDescriptions.push('authentication');

		if (featureDescriptions.length > 0) {
			parts.push(`featuring ${featureDescriptions.join(', ')}`);
		}

		return parts.join(' ') + '.';
	}

	/**
	 * Generate recommendations based on analysis
	 */
	private generateRecommendations(
		type: CodebaseType,
		features: CodebaseFeatures,
		patterns: string[]
	): string[] {
		const recommendations: string[] = [];

		if (type === 'frontend' && !features.hasStateManagement) {
			recommendations.push('Consider adding state management for complex UI state');
		}

		if (type === 'backend' && !features.hasTests) {
			recommendations.push('Add unit tests for API endpoints');
		}

		if (type === 'fullstack' && !features.hasDockerConfig) {
			recommendations.push('Consider adding Docker for consistent development environments');
		}

		if (features.hasApiRoutes && !features.hasAuthentication) {
			recommendations.push('Consider adding authentication to protect API endpoints');
		}

		return recommendations;
	}

	/**
	 * Get frontend-specific analysis
	 */
	async getFrontendAnalysis(): Promise<FrontendAnalysis | null> {
		const profile = await this.analyze();

		if (profile.type !== 'frontend' && profile.type !== 'fullstack') {
			return null;
		}

		const frontendFramework = profile.frameworks.find(f =>
			f.type === 'frontend' || f.type === 'fullstack'
		) ?? null;

		// Determine routing type
		let routingType: 'file-based' | 'config-based' | 'none' = 'none';
		if (frontendFramework?.name === 'Next.js' || frontendFramework?.name === 'Nuxt.js') {
			routingType = 'file-based';
		} else if (profile.features.hasRouting) {
			routingType = 'config-based';
		}

		// Extract state management libraries
		const stateManagement: string[] = [];
		const stateLibsArray = Array.from(STATE_MANAGEMENT_LIBS);
		for (const lib of stateLibsArray) {
			// Could be enhanced to actually check package.json
			stateManagement.push(lib);
		}

		// Extract UI libraries
		const uiLibraries: string[] = [];
		const uiLibsArray = Array.from(UI_LIBS);
		for (const lib of uiLibsArray) {
			uiLibraries.push(lib);
		}

		return {
			framework: frontendFramework,
			routingType,
			stateManagement: profile.features.hasStateManagement ? stateManagement : [],
			uiLibraries: profile.features.hasStyling ? uiLibraries : [],
			hasSSR: profile.features.hasServerSideRendering,
			hasSSG: frontendFramework?.name === 'Next.js' || frontendFramework?.name === 'Nuxt.js'
		};
	}

	/**
	 * Get backend-specific analysis
	 */
	async getBackendAnalysis(): Promise<BackendAnalysis | null> {
		const profile = await this.analyze();

		if (profile.type !== 'backend' && profile.type !== 'fullstack') {
			return null;
		}

		const backendFramework = profile.frameworks.find(f => f.type === 'backend') ?? null;

		// Get architecture result for more details
		const archResult = await this.architectureAnalyzer.analyze();
		const databases = archResult.components
			.filter(c => c.kind === 'database')
			.map(c => c.technology ?? c.label);

		// Determine ORM
		let ormUsed: string | null = null;
		if (this.checkForDependencies(archResult, new Set(['prisma', '@prisma/client']))) {
			ormUsed = 'Prisma';
		} else if (this.checkForDependencies(archResult, new Set(['typeorm']))) {
			ormUsed = 'TypeORM';
		} else if (this.checkForDependencies(archResult, new Set(['sequelize']))) {
			ormUsed = 'Sequelize';
		} else if (this.checkForDependencies(archResult, new Set(['drizzle-orm']))) {
			ormUsed = 'Drizzle';
		} else if (this.checkForDependencies(archResult, new Set(['mongoose']))) {
			ormUsed = 'Mongoose';
		}

		return {
			framework: backendFramework,
			routeCount: 0, // TODO: Implement route counting
			hasControllers: profile.detectedPatterns.includes('MVC'),
			hasServices: this.hasLayeredStructure(archResult),
			hasRepositories: this.hasLayeredStructure(archResult),
			databases,
			ormUsed
		};
	}

	/**
	 * Clear cached results
	 */
	clearCache(): void {
		this.cachedProfile = undefined;
		this.cacheTimestamp = 0;
	}
}
