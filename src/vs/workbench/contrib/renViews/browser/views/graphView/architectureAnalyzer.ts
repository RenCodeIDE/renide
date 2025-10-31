/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { ResourceMap } from '../../../../../../base/common/map.js';
import { mixin } from '../../../../../../base/common/objects.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { IFileService, FileSystemProviderError, FileSystemProviderErrorCode } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { ISearchService, ITextQuery, QueryType, resultIsMatch, ISearchProgressItem, IFileMatch, isFileMatch } from '../../../../../services/search/common/search.js';

import { GraphWorkspaceContext } from './graphContext.js';
import { GRAPH_DEFAULT_EXCLUDE_GLOBS, toCytoscapeId } from './graphConstants.js';

export type ArchitectureComponentKind =
	| 'application'
	| 'frontend'
	| 'backend'
	| 'database'
	| 'cache'
	| 'queue'
	| 'messageBus'
	| 'externalService'
	| 'infrastructure'
	| 'configuration'
	| 'supportingService'
	| 'dataset'
	| 'unknown';

export type ArchitectureRelationshipKind =
	| 'hosts'
	| 'dependsOn'
	| 'connectsTo'
	| 'calls'
	| 'publishes'
	| 'consumes'
	| 'stores'
	| 'queries';

export interface DetectionEvidence {
	description: string;
	resource?: URI;
	snippet?: string;
	confidence: number;
}

interface SchemaSummary {
	type: 'prisma' | 'sql';
	file: string;
	models?: Array<{ name: string; fields: Array<{ name: string; type: string }> }>;
	tables?: Array<{ name: string; columns: string[] }>;
}

interface HttpCallSummary {
	method: string;
	url: string;
	resource: string;
	file: string;
	snippet?: string;
}

interface GraphQLOperationSummary {
	type: string;
	name?: string;
	file: string;
	snippet: string;
}

type PackageManifest = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
};

export interface ArchitectureComponent {
	id: string;
	key: string;
	kind: ArchitectureComponentKind;
	label: string;
	confidence: number;
	language?: string;
	technology?: string;
	description?: string;
	tags: string[];
	location?: URI;
	metadata: Record<string, unknown>;
	evidence: DetectionEvidence[];
}

export interface ArchitectureRelationship {
	id: string;
	key: string;
	source: string;
	target: string;
	kind: ArchitectureRelationshipKind;
	confidence: number;
	description?: string;
	metadata: Record<string, unknown>;
	evidence: DetectionEvidence[];
}

export interface ArchitectureAnalysisResult {
	components: ArchitectureComponent[];
	relationships: ArchitectureRelationship[];
	warnings: string[];
	summary: string[];
	generatedAt: number;
}

export interface ArchitectureAnalyzeOptions {
	force?: boolean;
	maxWorkspaceSymbols?: number;
}

type WorkspaceSymbolLike = {
	name?: string;
	containerName?: string;
	kind?: number;
	location?: { uri?: URI };
};

class ArchitectureModelBuilder {
	private readonly components = new Map<string, ArchitectureComponent>();
	private readonly relationships = new Map<string, ArchitectureRelationship>();
	private readonly warnings = new Set<string>();
	private readonly summary = new Set<string>();

	constructor(private readonly logService: ILogService) { }

	ensureComponent(key: string, factory: () => Omit<ArchitectureComponent, 'id' | 'key' | 'metadata' | 'evidence'> & { metadata?: Record<string, unknown>; evidence?: DetectionEvidence[] }): ArchitectureComponent {
		let existing = this.components.get(key);
		if (!existing) {
			const created = factory();
			existing = {
				id: toCytoscapeId(key ?? generateUuid()),
				key,
				kind: created.kind,
				label: created.label,
				confidence: created.confidence,
				language: created.language,
				technology: created.technology,
				description: created.description,
				tags: [...new Set(created.tags ?? [])],
				location: created.location,
				metadata: { ...(created.metadata ?? {}) },
				evidence: [...(created.evidence ?? [])]
			};
			this.components.set(key, existing);
		} else {
			if (factory) {
				try {
					const snapshot = factory();
					existing.confidence = Math.max(existing.confidence, snapshot.confidence);
					existing.tags = [...new Set([...existing.tags, ...(snapshot.tags ?? [])])];
					existing.language = existing.language ?? snapshot.language;
					existing.technology = existing.technology ?? snapshot.technology;
					existing.description = existing.description ?? snapshot.description;
					if (snapshot.metadata) {
						existing.metadata = mixin(existing.metadata, snapshot.metadata, false);
					}
					existing.evidence.push(...(snapshot.evidence ?? []));
				} catch (error) {
					this.logService.debug('[ArchitectureModelBuilder] failed to merge component snapshot', key, error);
				}
			}
		}
		return existing;
	}

	augmentComponent(key: string, updater: (existing: ArchitectureComponent) => void): ArchitectureComponent | undefined {
		const component = this.components.get(key);
		if (component) {
			updater(component);
		}
		return component;
	}

	addEvidence(key: string, evidence: DetectionEvidence): void {
		const component = this.components.get(key);
		if (!component) {
			return;
		}
		const duplicate = component.evidence.find(entry => entry.description === evidence.description && entry.resource?.toString() === evidence.resource?.toString());
		if (!duplicate) {
			component.evidence.push(evidence);
			component.confidence = Math.min(1, component.confidence + evidence.confidence * 0.1);
		}
	}

	ensureRelationship(key: string, factory: () => Omit<ArchitectureRelationship, 'id' | 'key' | 'metadata' | 'evidence'> & { metadata?: Record<string, unknown>; evidence?: DetectionEvidence[] }): ArchitectureRelationship {
		let existing = this.relationships.get(key);
		if (!existing) {
			const created = factory();
			existing = {
				id: toCytoscapeId(`rel:${key}`),
				key,
				source: created.source,
				target: created.target,
				kind: created.kind,
				confidence: created.confidence,
				description: created.description,
				metadata: { ...(created.metadata ?? {}) },
				evidence: [...(created.evidence ?? [])]
			};
			this.relationships.set(key, existing);
		} else {
			const snapshot = factory();
			existing.confidence = Math.max(existing.confidence, snapshot.confidence);
			if (snapshot.description && !existing.description) {
				existing.description = snapshot.description;
			}
			if (snapshot.metadata) {
				existing.metadata = mixin(existing.metadata, snapshot.metadata, false);
			}
			existing.evidence.push(...(snapshot.evidence ?? []));
		}
		return existing;
	}

	addWarning(message: string): void {
		this.warnings.add(message);
	}

	addSummary(entry: string): void {
		this.summary.add(entry);
	}

	finalize(): ArchitectureAnalysisResult {
		const components = Array.from(this.components.values()).map(component => ({
			...component,
			evidence: component.evidence.sort((a, b) => b.confidence - a.confidence)
		}));
		const relationships = Array.from(this.relationships.values()).map(relationship => ({
			...relationship,
			evidence: relationship.evidence.sort((a, b) => b.confidence - a.confidence)
		}));
		return {
			components,
			relationships,
			warnings: Array.from(this.warnings),
			summary: Array.from(this.summary),
			generatedAt: Date.now()
		};
	}
}

export class ArchitectureAnalyzer {
	private cachedResult: ArchitectureAnalysisResult | undefined;
	private cacheTimestamp = 0;
	private readonly cacheTtlMs = 5 * 60 * 1000; // 5 minutes
	private readonly onProgressEmitter = new Emitter<string>();
	private readonly textCache = new ResourceMap<string>();
	private readonly datasetLimitPerApp = 150;
	private readonly datasetCounts = new Map<string, number>();
	private readonly datasetKeys = new Set<string>();
	private readonly datasetLimitWarned = new Set<string>();
	private readonly datasetMissingBackendWarned = new Set<string>();
	private readonly backendsByApplication = new Map<string, Set<string>>();
	private readonly frontendsByApplication = new Map<string, Set<string>>();
	private readonly componentToApplication = new Map<string, string>();
	private readonly componentLabels = new Map<string, string>();

	readonly onProgress = this.onProgressEmitter.event;

	constructor(
		private readonly logService: ILogService,
		private readonly fileService: IFileService,
		private readonly searchService: ISearchService,
		private readonly commandService: ICommandService,
		private readonly languageFeaturesService: ILanguageFeaturesService,
		private readonly context: GraphWorkspaceContext
	) { }

	async analyze(options: ArchitectureAnalyzeOptions = {}): Promise<ArchitectureAnalysisResult> {
		if (!options.force && this.cachedResult && Date.now() - this.cacheTimestamp < this.cacheTtlMs) {
			return this.cachedResult;
		}

		const builder = new ArchitectureModelBuilder(this.logService);
		this.datasetCounts.clear();
		this.datasetKeys.clear();
		this.datasetLimitWarned.clear();
		this.datasetMissingBackendWarned.clear();
		this.backendsByApplication.clear();
		this.frontendsByApplication.clear();
		this.componentToApplication.clear();
		this.componentLabels.clear();

		this.onProgressEmitter.fire('Collecting workspace structure…');
		await this.detectBaselineApplications(builder);
		this.onProgressEmitter.fire('Analyzing JavaScript / TypeScript dependencies…');
		await this.detectNodeEcosystem(builder);
		this.onProgressEmitter.fire('Analyzing Python dependencies…');
		await this.detectPythonEcosystem(builder);
		this.onProgressEmitter.fire('Analyzing Go modules…');
		await this.detectGoEcosystem(builder);
		this.onProgressEmitter.fire('Analyzing Rust crates…');
		await this.detectRustEcosystem(builder);
		this.onProgressEmitter.fire('Inspecting container orchestration configs…');
		await this.detectDockerCompose(builder);
		this.onProgressEmitter.fire('Collecting database schema definitions…');
		await this.detectDatabaseSchemas(builder);
		this.onProgressEmitter.fire('Scanning GraphQL operations…');
		await this.detectGraphQLOperations(builder);
		this.onProgressEmitter.fire('Collecting language server symbols…');
		await this.detectWorkspaceSymbols(builder, options.maxWorkspaceSymbols ?? 120);
		this.onProgressEmitter.fire('Scanning HTTP and RPC clients…');
		await this.detectHttpClients(builder);
		this.onProgressEmitter.fire('Scanning SQL queries…');
		await this.detectSqlQueries(builder);

		const result = builder.finalize();
		const datasetCount = result.components.filter(component => component.kind === 'dataset').length;
		const dataFlowCount = result.relationships.filter(relationship => relationship.kind === 'queries').length;
		this.logService.info(`[ArchitectureAnalyzer] components=${result.components.length} datasets=${datasetCount} relationships=${result.relationships.length} dataFlows=${dataFlowCount} warnings=${result.warnings.length}`);
		this.cachedResult = result;
		this.cacheTimestamp = Date.now();
		return result;
	}

	private async detectBaselineApplications(builder: ArchitectureModelBuilder): Promise<void> {
		for (const folder of this.context.getWorkspaceFolders()) {
			const key = `application:${folder.uri.toString()}`;
			builder.ensureComponent(key, () => ({
				kind: 'application',
				label: folder.name ?? this.context.extUri.basename(folder.uri),
				confidence: 0.3,
				tags: ['workspace'],
				metadata: { workspaceFolder: folder.uri.toString(true) },
				evidence: []
			}));
		}
	}

	private async detectNodeEcosystem(builder: ArchitectureModelBuilder): Promise<void> {
		const folders = this.context.getWorkspaceFolders();
		for (const folder of folders) {
			const packageUri = this.context.extUri.joinPath(folder.uri, 'package.json');
			const packageBuffer = await this.tryReadFile(packageUri);
			if (!packageBuffer) {
				continue;
			}
			let manifest: PackageManifest | undefined;
			try {
				manifest = JSON.parse(packageBuffer.toString()) as PackageManifest;
			} catch (error) {
				this.logService.warn('[ArchitectureAnalyzer] failed to parse package.json', packageUri.toString(true), error);
				builder.addWarning(`Failed to parse package.json in ${folder.name}`);
				continue;
			}
			if (!manifest) {
				continue;
			}
			const dependencies = this.mergeDependencies(manifest);
			const scripts: Record<string, string> = manifest.scripts ?? {};
			const hasTypeScript = this.hasDependency(dependencies, 'typescript') || this.hasDependency(dependencies, 'ts-node') || Object.values(scripts).some(script => /tsc|ts-node/.test(script));

			const applicationKey = `application:${folder.uri.toString()}`;
			builder.augmentComponent(applicationKey, component => {
				component.language = component.language ?? (hasTypeScript ? 'TypeScript' : 'JavaScript');
				component.metadata.runtime = 'Node.js';
			});

			const frontendFrameworks = this.detectFrontendFrameworks(dependencies);
			for (const framework of frontendFrameworks) {
				const frontendKey = `frontend:${framework.id}:${folder.uri.toString()}`;
				builder.ensureComponent(frontendKey, () => ({
					kind: 'frontend',
					label: `${framework.label} Frontend`,
					confidence: framework.confidence,
					language: hasTypeScript ? 'TypeScript' : 'JavaScript',
					technology: framework.label,
					tags: ['frontend', 'web'],
					metadata: { workspaceFolder: folder.uri.toString(true), package: packageUri.toString(true) },
					evidence: [
						{
							description: `Dependency on ${framework.dependency}`,
							resource: packageUri,
							confidence: framework.confidence,
							snippet: `"${framework.dependency}": "${dependencies[framework.dependency]}"`
						}
					]
				}));
				this.registerFrontend(applicationKey, frontendKey, `${framework.label} Frontend`);
				builder.ensureRelationship(`hosts:${applicationKey}->${frontendKey}`, () => ({
					source: applicationKey,
					target: frontendKey,
					kind: 'hosts',
					confidence: framework.confidence,
					description: `${framework.label} frontend inside ${folder.name}`,
					metadata: {},
					evidence: []
				}));
				builder.addSummary(`Detected ${framework.label} frontend in ${folder.name}`);
			}

			const backendFrameworks = this.detectBackendFrameworks(dependencies, scripts);
			for (const backend of backendFrameworks) {
				const backendKey = `backend:${backend.id}:${folder.uri.toString()}`;
				const dependencyVersion = backend.dependency ? dependencies[backend.dependency] : undefined;
				const evidenceDescription = backend.dependency && dependencyVersion
					? `Dependency on ${backend.dependency}`
					: 'Backend service inferred from project configuration';
				const evidence: DetectionEvidence = {
					description: evidenceDescription,
					resource: packageUri,
					confidence: backend.confidence
				};
				if (dependencyVersion) {
					evidence.snippet = `"${backend.dependency}": "${dependencyVersion}"`;
				}
				builder.ensureComponent(backendKey, () => ({
					kind: 'backend',
					label: `${backend.label} Backend`,
					confidence: backend.confidence,
					language: hasTypeScript ? 'TypeScript' : 'JavaScript',
					technology: backend.label,
					tags: ['backend', 'server'],
					metadata: { workspaceFolder: folder.uri.toString(true), package: packageUri.toString(true) },
					evidence: [evidence]
				}));
				this.registerBackend(applicationKey, backendKey, `${backend.label} Backend`);
				builder.ensureRelationship(`hosts:${applicationKey}->${backendKey}`, () => ({
					source: applicationKey,
					target: backendKey,
					kind: 'hosts',
					confidence: backend.confidence,
					description: `${backend.label} backend inside ${folder.name}`,
					metadata: {},
					evidence: []
				}));
				builder.addSummary(`Detected ${backend.label} backend in ${folder.name}`);
			}

			const databaseConnectors = this.detectDatabaseConnectors(dependencies);
			for (const db of databaseConnectors) {
				const databaseKey = `database:${db.id}`;
				builder.ensureComponent(databaseKey, () => ({
					kind: 'database',
					label: db.label,
					confidence: db.confidence,
					language: undefined,
					technology: db.label,
					tags: ['database'],
					metadata: { suggestedTechnology: db.label },
					evidence: [
						{
							description: `Dependency on ${db.dependency}`,
							resource: packageUri,
							confidence: db.confidence,
							snippet: `"${db.dependency}": "${dependencies[db.dependency]}"`
						}
					]
				}));
				for (const backend of backendFrameworks) {
					const backendKey = `backend:${backend.id}:${folder.uri.toString()}`;
					builder.ensureRelationship(`connects:${backendKey}->${databaseKey}`, () => ({
						source: backendKey,
						target: databaseKey,
						kind: 'connectsTo',
						confidence: Math.min(1, (backend.confidence + db.confidence) / 2),
						description: `${backend.label} likely connects to ${db.label}`,
						metadata: {},
						evidence: []
					}));
				}
				builder.addSummary(`Detected ${db.label} dependency`);
			}

			const cacheSystems = this.detectCacheSystems(dependencies);
			for (const cache of cacheSystems) {
				const cacheKey = `cache:${cache.id}`;
				builder.ensureComponent(cacheKey, () => ({
					kind: 'cache',
					label: cache.label,
					confidence: cache.confidence,
					language: undefined,
					technology: cache.label,
					tags: ['cache'],
					metadata: {},
					evidence: [
						{
							description: `Dependency on ${cache.dependency}`,
							resource: packageUri,
							confidence: cache.confidence,
							snippet: `"${cache.dependency}": "${dependencies[cache.dependency]}"`
						}
					]
				}));
				for (const backend of backendFrameworks) {
					const backendKey = `backend:${backend.id}:${folder.uri.toString()}`;
					builder.ensureRelationship(`connects:${backendKey}->${cacheKey}`, () => ({
						source: backendKey,
						target: cacheKey,
						kind: 'connectsTo',
						confidence: Math.min(1, (backend.confidence + cache.confidence) / 2),
						description: `${backend.label} likely uses ${cache.label}`,
						metadata: {},
						evidence: []
					}));
				}
				builder.addSummary(`Detected ${cache.label} cache dependency`);
			}

			const messageBuses = this.detectMessagingSystems(dependencies);
			for (const bus of messageBuses) {
				const queueKey = `queue:${bus.id}`;
				builder.ensureComponent(queueKey, () => ({
					kind: bus.kind,
					label: bus.label,
					confidence: bus.confidence,
					language: undefined,
					technology: bus.label,
					tags: ['queue'],
					metadata: {},
					evidence: [
						{
							description: `Dependency on ${bus.dependency}`,
							resource: packageUri,
							confidence: bus.confidence,
							snippet: `"${bus.dependency}": "${dependencies[bus.dependency]}"`
						}
					]
				}));
				for (const backend of backendFrameworks) {
					const backendKey = `backend:${backend.id}:${folder.uri.toString()}`;
					builder.ensureRelationship(`connects:${backendKey}->${queueKey}`, () => ({
						source: backendKey,
						target: queueKey,
						kind: bus.kind === 'messageBus' ? 'publishes' : 'consumes',
						confidence: bus.confidence,
						description: `${backend.label} integrates with ${bus.label}`,
						metadata: {},
						evidence: []
					}));
				}
				builder.addSummary(`Detected ${bus.label} integration`);
			}
		}
	}

	private detectFrontendFrameworks(dependencies: Record<string, string>): Array<{ id: string; label: string; dependency: string; confidence: number }> {
		const frameworks: Array<{ id: string; label: string; dependency: string; confidence: number }> = [];
		const push = (id: string, dependency: string, label: string, confidence = 0.6) => {
			if (this.hasDependency(dependencies, dependency)) {
				frameworks.push({ id, dependency, label, confidence });
			}
		};
		push('react', 'react', 'React', 0.75);
		push('nextjs', 'next', 'Next.js', 0.85);
		push('vue', 'vue', 'Vue.js', 0.7);
		push('nuxt', 'nuxt', 'Nuxt.js', 0.75);
		push('svelte', 'svelte', 'Svelte', 0.65);
		push('angular', '@angular/core', 'Angular', 0.7);
		push('vite', 'vite', 'Vite', 0.5);
		push('remix', '@remix-run/react', 'Remix', 0.7);
		return frameworks;
	}

	private detectBackendFrameworks(dependencies: Record<string, string>, scripts: Record<string, string>): Array<{ id: string; label: string; dependency: string; confidence: number }> {
		const frameworks: Array<{ id: string; label: string; dependency: string; confidence: number }> = [];
		const add = (id: string, dependency: string, label: string, confidence = 0.6) => {
			if (this.hasDependency(dependencies, dependency)) {
				frameworks.push({ id, dependency, label, confidence });
			}
		};
		add('express', 'express', 'Express.js', 0.7);
		add('koa', 'koa', 'Koa', 0.6);
		add('nestjs', '@nestjs/core', 'NestJS', 0.75);
		add('fastify', 'fastify', 'Fastify', 0.65);
		add('apollo', 'apollo-server', 'Apollo GraphQL', 0.65);
		add('hapi', '@hapi/hapi', 'hapi', 0.6);
		add('serverless', 'serverless-http', 'Serverless HTTP', 0.5);
		add('hono', 'hono', 'Hono', 0.6);
		add('trpc', '@trpc/server', 'tRPC', 0.55);
		add('adonis', '@adonisjs/core', 'AdonisJS', 0.55);
		if (this.hasDependency(dependencies, 'ts-node-dev') || Object.values(scripts).some(script => /nodemon|ts-node-dev/.test(script))) {
			frameworks.push({ id: 'node-server', dependency: 'node', label: 'Node.js service', confidence: 0.45 });
		}
		if (!frameworks.length) {
			const fallbackDeps = [
				{ id: 'prisma-service', dependency: '@prisma/client', label: 'Prisma Service', confidence: 0.55 },
				{ id: 'prisma-service', dependency: 'prisma', label: 'Prisma Service', confidence: 0.5 },
				{ id: 'drizzle-service', dependency: 'drizzle-orm', label: 'Drizzle Service', confidence: 0.5 },
				{ id: 'typeorm-service', dependency: 'typeorm', label: 'TypeORM Service', confidence: 0.5 },
				{ id: 'mongoose-service', dependency: 'mongoose', label: 'Mongoose Service', confidence: 0.5 }
			];
			for (const fallback of fallbackDeps) {
				if (this.hasDependency(dependencies, fallback.dependency)) {
					frameworks.push(fallback);
					break;
				}
			}
		}
		return frameworks;
	}

	private detectDatabaseConnectors(dependencies: Record<string, string>): Array<{ id: string; label: string; dependency: string; confidence: number }> {
		const connectors: Array<{ id: string; label: string; dependency: string; confidence: number }> = [];
		const add = (id: string, dependency: string, label: string, confidence = 0.6) => {
			if (this.hasDependency(dependencies, dependency)) {
				connectors.push({ id, label, dependency, confidence });
			}
		};
		add('postgresql', 'pg', 'PostgreSQL', 0.75);
		add('postgresql', 'pg-promise', 'PostgreSQL', 0.65);
		add('mysql', 'mysql2', 'MySQL', 0.7);
		add('mysql', 'mysql', 'MySQL', 0.6);
		add('mongodb', 'mongoose', 'MongoDB', 0.75);
		add('mongodb', 'mongodb', 'MongoDB', 0.6);
		add('dynamodb', '@aws-sdk/client-dynamodb', 'Amazon DynamoDB', 0.6);
		add('prisma', '@prisma/client', 'Relational Database via Prisma', 0.65);
		add('sqlite', 'better-sqlite3', 'SQLite', 0.6);
		add('elasticsearch', '@elastic/elasticsearch', 'Elasticsearch', 0.6);
		return connectors;
	}

	private detectCacheSystems(dependencies: Record<string, string>): Array<{ id: string; label: string; dependency: string; confidence: number }> {
		const caches: Array<{ id: string; label: string; dependency: string; confidence: number }> = [];
		const add = (id: string, dependency: string, label: string, confidence = 0.6) => {
			if (this.hasDependency(dependencies, dependency)) {
				caches.push({ id, label, dependency, confidence });
			}
		};
		add('redis', 'redis', 'Redis Cache', 0.75);
		add('redis', 'ioredis', 'Redis Cache', 0.75);
		add('memcached', 'memcached', 'Memcached', 0.65);
		add('node-cache', 'node-cache', 'In-memory Cache', 0.4);
		return caches;
	}

	private detectMessagingSystems(dependencies: Record<string, string>): Array<{ id: string; label: string; dependency: string; confidence: number; kind: ArchitectureComponentKind }> {
		const buses: Array<{ id: string; label: string; dependency: string; confidence: number; kind: ArchitectureComponentKind }> = [];
		const add = (id: string, dependency: string, label: string, confidence: number, kind: ArchitectureComponentKind) => {
			if (this.hasDependency(dependencies, dependency)) {
				buses.push({ id, dependency, label, confidence, kind });
			}
		};
		add('rabbitmq', 'amqplib', 'RabbitMQ', 0.65, 'queue');
		add('kafka', 'kafkajs', 'Apache Kafka', 0.7, 'messageBus');
		add('bull', 'bull', 'Bull Queue (Redis)', 0.6, 'queue');
		add('bullmq', 'bullmq', 'BullMQ Queue', 0.6, 'queue');
		add('sqs', '@aws-sdk/client-sqs', 'Amazon SQS', 0.6, 'queue');
		return buses;
	}

	private mergeDependencies(manifest: PackageManifest): Record<string, string> {
		return {
			...(manifest.dependencies ?? {}),
			...(manifest.devDependencies ?? {}),
			...(manifest.peerDependencies ?? {})
		};
	}

	private async detectPythonEcosystem(builder: ArchitectureModelBuilder): Promise<void> {
		for (const folder of this.context.getWorkspaceFolders()) {
			const requirementsUri = this.context.extUri.joinPath(folder.uri, 'requirements.txt');
			const requirementsBuffer = await this.tryReadFile(requirementsUri);
			const packages = new Set<string>();
			if (requirementsBuffer) {
				for (const line of requirementsBuffer.toString().split(/\r?\n/)) {
					const token = line.trim().toLowerCase();
					if (!token || token.startsWith('#')) {
						continue;
					}
					const pkgName = token.split(/[<>=]/)[0]?.trim();
					if (pkgName) {
						packages.add(pkgName);
					}
				}
			}
			const pyprojectUri = this.context.extUri.joinPath(folder.uri, 'pyproject.toml');
			const pyprojectBuffer = await this.tryReadFile(pyprojectUri);
			if (pyprojectBuffer) {
				const text = pyprojectBuffer.toString().toLowerCase();
				const dependencySectionMatch = text.match(/\[tool\.(poetry|pdm)\.dependencies\][\s\S]*?(\n\[|$)/);
				if (dependencySectionMatch) {
					for (const line of dependencySectionMatch[0].split(/\r?\n/)) {
						const token = line.split('=')[0]?.trim();
						if (token && !token.startsWith('[') && token.length > 1) {
							packages.add(token.replace(/['"]/g, ''));
						}
					}
				} else {
					for (const match of text.matchAll(/"([^"]+)"\s*=\s*"[^"]+"/g)) {
						packages.add(match[1]);
					}
				}
			}
			if (!packages.size) {
				continue;
			}
			const applicationKey = `application:${folder.uri.toString()}`;
			builder.augmentComponent(applicationKey, component => {
				component.language = component.language ?? 'Python';
				component.metadata.runtime = component.metadata.runtime ?? 'Python';
			});

			const backendCandidates: Array<{ id: string; label: string; evidencePkg: string; confidence: number }> = [];
			const addBackend = (id: string, pkg: string, label: string, confidence = 0.7) => {
				if (packages.has(pkg)) {
					backendCandidates.push({ id, label, evidencePkg: pkg, confidence });
				}
			};
			addBackend('django', 'django', 'Django', 0.8);
			addBackend('fastapi', 'fastapi', 'FastAPI', 0.75);
			addBackend('flask', 'flask', 'Flask', 0.65);
			addBackend('tornado', 'tornado', 'Tornado', 0.6);
			addBackend('celery-worker', 'celery', 'Celery Worker', 0.6);

			for (const backend of backendCandidates) {
				const backendKey = `backend:${backend.id}:${folder.uri.toString()}`;
				builder.ensureComponent(backendKey, () => ({
					kind: backend.id === 'celery-worker' ? 'supportingService' : 'backend',
					label: `${backend.label} Backend`,
					confidence: backend.confidence,
					language: 'Python',
					technology: backend.label,
					tags: ['python'],
					metadata: { workspaceFolder: folder.uri.toString(true) },
					evidence: [
						{
							description: `Dependency on ${backend.evidencePkg}`,
							resource: requirementsBuffer ? requirementsUri : pyprojectBuffer ? pyprojectUri : undefined,
							confidence: backend.confidence
						}
					]
				}));
				this.registerBackend(applicationKey, backendKey, `${backend.label} Backend`);
				builder.ensureRelationship(`hosts:${applicationKey}->${backendKey}`, () => ({
					source: applicationKey,
					target: backendKey,
					kind: 'hosts',
					confidence: backend.confidence,
					description: `${backend.label} backend inside ${folder.name}`,
					metadata: {},
					evidence: []
				}));
				builder.addSummary(`Detected Python backend (${backend.label}) in ${folder.name}`);
			}

			const pythonDatabases = [
				{ id: 'postgresql', pkg: 'psycopg2', label: 'PostgreSQL', confidence: 0.7 },
				{ id: 'postgresql', pkg: 'asyncpg', label: 'PostgreSQL', confidence: 0.65 },
				{ id: 'mysql', pkg: 'mysqlclient', label: 'MySQL', confidence: 0.65 },
				{ id: 'sqlite', pkg: 'sqlite3', label: 'SQLite', confidence: 0.6 },
				{ id: 'mongodb', pkg: 'pymongo', label: 'MongoDB', confidence: 0.65 },
				{ id: 'redis', pkg: 'redis', label: 'Redis Cache', confidence: 0.65 },
				{ id: 'rabbitmq', pkg: 'pika', label: 'RabbitMQ', confidence: 0.6 }
			];
			for (const db of pythonDatabases) {
				if (!packages.has(db.pkg)) {
					continue;
				}
				const databaseKey = `${db.id}:${db.pkg}`;
				builder.ensureComponent(`database:${databaseKey}`, () => ({
					kind: db.id === 'redis' ? 'cache' : db.id === 'rabbitmq' ? 'queue' : 'database',
					label: db.label,
					confidence: db.confidence,
					language: undefined,
					technology: db.label,
					tags: ['python'],
					metadata: {},
					evidence: [
						{
							description: `Dependency on ${db.pkg}`,
							resource: requirementsBuffer ? requirementsUri : pyprojectBuffer ? pyprojectUri : undefined,
							confidence: db.confidence
						}
					]
				}));
			}
		}
	}

	private async detectGoEcosystem(builder: ArchitectureModelBuilder): Promise<void> {
		for (const folder of this.context.getWorkspaceFolders()) {
			const gomodUri = this.context.extUri.joinPath(folder.uri, 'go.mod');
			const config = await this.tryReadFile(gomodUri);
			if (!config) {
				continue;
			}
			const text = config.toString();
			const deps = Array.from(text.matchAll(/require\s+([^\s]+)\s+v[0-9\.\-]+/g)).map(match => match[1]);
			if (!deps.length) {
				continue;
			}
			const applicationKey = `application:${folder.uri.toString()}`;
			builder.augmentComponent(applicationKey, component => {
				component.language = 'Go';
				component.metadata.runtime = 'Go';
			});

			const backendCandidates: Array<{ id: string; label: string; evidence: string; confidence: number }> = [];
			const addBackend = (id: string, module: string, label: string, confidence = 0.7) => {
				if (deps.some(dep => dep.includes(module))) {
					backendCandidates.push({ id, label, evidence: module, confidence });
				}
			};
			addBackend('gin', 'github.com/gin-gonic/gin', 'Gin', 0.75);
			addBackend('echo', 'github.com/labstack/echo', 'Echo', 0.7);
			addBackend('fiber', 'github.com/gofiber/fiber', 'Fiber', 0.7);
			addBackend('grpc', 'google.golang.org/grpc', 'gRPC Service', 0.65);

			for (const backend of backendCandidates) {
				const backendKey = `backend:${backend.id}:${folder.uri.toString()}`;
				builder.ensureComponent(backendKey, () => ({
					kind: 'backend',
					label: `${backend.label} Backend`,
					confidence: backend.confidence,
					language: 'Go',
					technology: backend.label,
					tags: ['go'],
					metadata: {},
					evidence: [
						{
							description: `Dependency on ${backend.evidence}`,
							resource: gomodUri,
							confidence: backend.confidence
						}
					]
				}));
				builder.ensureRelationship(`hosts:${applicationKey}->${backendKey}`, () => ({
					source: applicationKey,
					target: backendKey,
					kind: 'hosts',
					confidence: backend.confidence,
					description: `${backend.label} backend inside ${folder.name}`,
					metadata: {},
					evidence: []
				}));
			}

			const goDatabases = [
				{ id: 'postgresql', module: 'github.com/jackc/pgx', label: 'PostgreSQL', confidence: 0.7 },
				{ id: 'postgresql', module: 'github.com/lib/pq', label: 'PostgreSQL', confidence: 0.65 },
				{ id: 'mysql', module: 'github.com/go-sql-driver/mysql', label: 'MySQL', confidence: 0.65 },
				{ id: 'mongodb', module: 'go.mongodb.org/mongo-driver', label: 'MongoDB', confidence: 0.65 },
				{ id: 'redis', module: 'github.com/redis/go-redis', label: 'Redis Cache', confidence: 0.7 }
			];
			for (const db of goDatabases) {
				if (!deps.some(dep => dep.includes(db.module))) {
					continue;
				}
				const databaseKey = `database:${db.id}`;
				builder.ensureComponent(databaseKey, () => ({
					kind: db.id === 'redis' ? 'cache' : 'database',
					label: db.label,
					confidence: db.confidence,
					language: undefined,
					technology: db.label,
					tags: ['go'],
					metadata: {},
					evidence: [
						{
							description: `Dependency on ${db.module}`,
							resource: gomodUri,
							confidence: db.confidence
						}
					]
				}));
				for (const backend of backendCandidates) {
					const backendKey = `backend:${backend.id}:${folder.uri.toString()}`;
					builder.ensureRelationship(`connects:${backendKey}->${databaseKey}`, () => ({
						source: backendKey,
						target: databaseKey,
						kind: db.id === 'redis' ? 'connectsTo' : 'stores',
						confidence: Math.min(1, (backend.confidence + db.confidence) / 2),
						description: `${backend.label} likely integrates with ${db.label}`,
						metadata: {},
						evidence: []
					}));
				}
				builder.addSummary(`Detected Go dependency for ${db.label}`);
			}
		}
	}

	private async detectRustEcosystem(builder: ArchitectureModelBuilder): Promise<void> {
		for (const folder of this.context.getWorkspaceFolders()) {
			const cargoUri = this.context.extUri.joinPath(folder.uri, 'Cargo.toml');
			const buffer = await this.tryReadFile(cargoUri);
			if (!buffer) {
				continue;
			}
			const text = buffer.toString().toLowerCase();
			if (!text.includes('[dependencies]')) {
				continue;
			}
			builder.augmentComponent(`application:${folder.uri.toString()}`, component => {
				component.language = 'Rust';
				component.metadata.runtime = 'Rust';
			});

			const detect = (needle: string) => text.includes(needle);
			if (detect('actix-web')) {
				builder.ensureComponent(`backend:actix:${folder.uri.toString()}`, () => ({
					kind: 'backend',
					label: 'Actix-Web Backend',
					confidence: 0.75,
					language: 'Rust',
					technology: 'Actix Web',
					tags: ['rust'],
					metadata: {},
					evidence: [{ description: 'Dependency on actix-web', resource: cargoUri, confidence: 0.75 }]
				}));
			}
			if (detect('rocket =')) {
				builder.ensureComponent(`backend:rocket:${folder.uri.toString()}`, () => ({
					kind: 'backend',
					label: 'Rocket Backend',
					confidence: 0.7,
					language: 'Rust',
					technology: 'Rocket',
					tags: ['rust'],
					metadata: {},
					evidence: [{ description: 'Dependency on rocket', resource: cargoUri, confidence: 0.7 }]
				}));
			}

			if (detect('sqlx')) {
				builder.ensureComponent('database:sqlx', () => ({
					kind: 'database',
					label: 'SQLx Database',
					confidence: 0.65,
					language: undefined,
					technology: 'SQLx',
					tags: ['rust'],
					metadata: {},
					evidence: [{ description: 'Dependency on sqlx', resource: cargoUri, confidence: 0.65 }]
				}));
			}
		}
	}

	private async detectDockerCompose(builder: ArchitectureModelBuilder): Promise<void> {
		const composeFileNames = ['docker-compose.yml', 'docker-compose.yaml'];
		for (const folder of this.context.getWorkspaceFolders()) {
			for (const fileName of composeFileNames) {
				const composeUri = this.context.extUri.joinPath(folder.uri, fileName);
				const buffer = await this.tryReadFile(composeUri);
				if (!buffer) {
					continue;
				}
				const text = buffer.toString().toLowerCase();
				const services = Array.from(text.matchAll(/image:\s*([^\s#]+)/g)).map(match => match[1]);
				if (!services.length) {
					continue;
				}
				for (const image of services) {
					if (/postgres/.test(image)) {
						builder.ensureComponent('database:postgresql-compose', () => ({
							kind: 'database',
							label: 'PostgreSQL (Docker Compose)',
							confidence: 0.7,
							language: undefined,
							technology: 'PostgreSQL',
							tags: ['docker'],
							metadata: { image },
							evidence: [{ description: `Docker image ${image}`, resource: composeUri, confidence: 0.7 }]
						}));
					}
					if (/mongo/.test(image)) {
						builder.ensureComponent('database:mongodb-compose', () => ({
							kind: 'database',
							label: 'MongoDB (Docker Compose)',
							confidence: 0.65,
							language: undefined,
							technology: 'MongoDB',
							tags: ['docker'],
							metadata: { image },
							evidence: [{ description: `Docker image ${image}`, resource: composeUri, confidence: 0.65 }]
						}));
					}
					if (/redis/.test(image)) {
						builder.ensureComponent('cache:redis-compose', () => ({
							kind: 'cache',
							label: 'Redis (Docker Compose)',
							confidence: 0.7,
							technology: 'Redis',
							tags: ['docker'],
							metadata: { image },
							evidence: [{ description: `Docker image ${image}`, resource: composeUri, confidence: 0.7 }]
						}));
					}
				}
			}
		}
	}

	private async detectWorkspaceSymbols(builder: ArchitectureModelBuilder, limit: number): Promise<void> {
		const providerCount = this.languageFeaturesService.documentSymbolProvider.allNoModel().length;
		if (providerCount === 0) {
			builder.addWarning('No document symbol providers registered; architecture detection may miss services.');
		}
		const queries = ['Controller', 'Service', 'Repository', 'Resolver', 'Component', 'Client'];
		const symbolUsage = new ResourceMap<number>();
		for (const query of queries) {
			const symbols = await this.queryWorkspaceSymbols(query, limit);
			for (const symbol of symbols) {
				if (!symbol?.location?.uri) {
					continue;
				}
				const uri = symbol.location.uri;
				symbolUsage.set(uri, (symbolUsage.get(uri) ?? 0) + 1);
				const componentKey = this.inferComponentFromSymbol(symbol, uri);
				if (!componentKey) {
					continue;
				}
				builder.addEvidence(componentKey, {
					description: `Workspace symbol "${symbol.name ?? query}"`, // allow-any-unicode-next-line
					resource: uri,
					confidence: 0.2
				});
			}
		}
		if (!symbolUsage.size) {
			this.logService.debug('[ArchitectureAnalyzer] No workspace symbols detected for architecture analysis.');
		}
	}

	private inferComponentFromSymbol(symbol: WorkspaceSymbolLike, uri: URI): string | undefined {
		const path = uri.path.toLowerCase();
		const applicationKey = this.findApplicationKeyForResource(uri);
		if (!applicationKey) {
			return undefined;
		}
		const name = symbol.name ?? '';
		if (/controller|service|repository|handler|resolver/.test(name.toLowerCase()) || /api|server|routes/.test(path)) {
			return `backend:inferred:${applicationKey}`;
		}
		if (/component|view|page|widget/.test(name.toLowerCase()) || /client|ui|frontend|pages/.test(path)) {
			return `frontend:inferred:${applicationKey}`;
		}
		return applicationKey;
	}

	private findApplicationKeyForResource(uri: URI): string | undefined {
		for (const folder of this.context.getWorkspaceFolders()) {
			if (this.context.extUri.isEqualOrParent(uri, folder.uri)) {
				return `application:${folder.uri.toString()}`;
			}
		}
		return undefined;
	}

	private async detectHttpClients(builder: ArchitectureModelBuilder): Promise<void> {
		const folderQueries = this.context.getWorkspaceFolders().map(folder => ({ folder: folder.uri }));
		if (!folderQueries.length) {
			return;
		}
		const httpExpressions = [
			{ pattern: 'axios\\s*\\.\\s*(get|post|put|delete|patch|request)\\s*\\(', label: 'axios' },
			{ pattern: 'fetch\\s*\\(', label: 'fetch' },
			{ pattern: 'httpClient\\s*\\.', label: 'httpClient' }
		];
		let warnedForLimit = false;
		for (const expression of httpExpressions) {
			const query: ITextQuery = {
				type: QueryType.Text,
				folderQueries,
				contentPattern: {
					pattern: expression.pattern,
					isRegExp: true,
					isCaseSensitive: false
				},
				excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
				maxResults: 200
			};
			const matches: Array<{ uri: URI; text: string }> = [];
			const searchResult = await this.searchService.textSearch(query, CancellationToken.None, (progress: ISearchProgressItem) => {
				if (!progress || !isFileMatch(progress) || !progress.results) {
					return;
				}
				for (const result of progress.results) {
					if (!resultIsMatch(result)) {
						continue;
					}
					matches.push({ uri: progress.resource, text: result.previewText });
				}
			});
			if (!warnedForLimit && searchResult?.limitHit) {
				builder.addWarning('HTTP client detection reached the search result limit; some external API calls may be omitted.');
				warnedForLimit = true;
			}
			for (const match of matches) {
				const details = this.parseHttpSnippet(match.text, expression.label);
				if (!details.url) {
					continue;
				}
				const url = details.url.trim();
				const method = (details.method ?? expression.label).toUpperCase();
				const applicationKey = this.findApplicationKeyForResource(match.uri);
				const sourceKey = this.inferComponentForResource(match.uri) ?? applicationKey;
				const host = this.extractHost(url);
				const internalBackendKey = this.resolveInternalBackend(sourceKey, applicationKey, host, url);
				let targetResource = host ?? 'unknown';
				if (internalBackendKey && sourceKey) {
					const backendLabel = this.componentLabels.get(internalBackendKey) ?? 'Backend Service';
					targetResource = backendLabel;
					const relationshipKey = `calls:${sourceKey}->${internalBackendKey}:${method}:${url}`;
					builder.ensureRelationship(relationshipKey, () => ({
						source: sourceKey,
						target: internalBackendKey,
						kind: 'calls',
						confidence: 0.55,
						description: `HTTP ${method} ${url}`,
						metadata: {
							http: {
								method,
								url,
								resource: backendLabel,
								file: match.uri.toString(true)
							}
						},
						evidence: [
							{ description: `HTTP ${method} ${url}`, resource: match.uri, snippet: match.text.trim(), confidence: 0.5 }
						]
					}));
				} else {
					if (!host) {
						continue;
					}
					const externalKey = `externalService:${host}`;
					builder.ensureComponent(externalKey, () => ({
						kind: 'externalService',
						label: `External API (${host})`,
						confidence: 0.55,
						language: undefined,
						technology: host,
						tags: ['external'],
						metadata: { host, endpoints: [{ url, methods: [method] }] },
						evidence: []
					}));
					builder.augmentComponent(externalKey, component => {
						const metadata = component.metadata as Record<string, unknown>;
						const endpoints = Array.isArray(metadata.endpoints) ? metadata.endpoints as Array<{ url: string; methods: string[] }> : [];
						if (!Array.isArray(metadata.endpoints)) {
							metadata.endpoints = endpoints;
						}
						let endpoint = endpoints.find(entry => entry.url === url);
						if (!endpoint) {
							endpoint = { url, methods: [] };
							endpoints.push(endpoint);
						}
						if (!endpoint.methods.includes(method)) {
							endpoint.methods.push(method);
						}
					});
					if (sourceKey) {
						const relationshipKey = `calls:${method}:${url}:${sourceKey}->${externalKey}`;
						builder.ensureRelationship(relationshipKey, () => ({
							source: sourceKey,
							target: externalKey,
							kind: 'calls',
							confidence: 0.55,
							description: `HTTP ${method} ${url}`,
							metadata: {
								http: {
									method,
									url,
									resource: host,
									file: match.uri.toString(true)
								}
							},
							evidence: [
								{ description: `HTTP ${method} ${url}`, resource: match.uri, snippet: match.text.trim(), confidence: 0.5 }
							]
						}));
					}
				}
				if (sourceKey) {
					const callSummary: HttpCallSummary = {
						method,
						url,
						resource: targetResource,
						file: match.uri.toString(true),
						snippet: match.text.trim()
					};
					this.appendMetadataArray(builder, sourceKey, 'httpCalls', callSummary);
				}
			}
		}
	}

	private async detectDatabaseSchemas(builder: ArchitectureModelBuilder): Promise<void> {
		for (const folder of this.context.getWorkspaceFolders()) {
			const applicationKey = `application:${folder.uri.toString()}`;
			const prismaUri = this.context.extUri.joinPath(folder.uri, 'prisma/schema.prisma');
			const prismaBuffer = await this.tryReadFile(prismaUri);
			if (prismaBuffer) {
				const prismaText = prismaBuffer.toString();
				const modelMatches = Array.from(prismaText.matchAll(/model\s+(\w+)\s+\{([\s\S]*?)\}/g));
				if (modelMatches.length) {
					const models = modelMatches.map(match => {
						const fields: Array<{ name: string; type: string }> = [];
						for (const line of match[2].split(/\r?\n/)) {
							const fieldMatch = /^\s*(\w+)\s+([\w\[\]!?.]+).*$/i.exec(line.trim());
							if (fieldMatch) {
								fields.push({ name: fieldMatch[1], type: fieldMatch[2] });
							}
						}
						return { name: match[1], fields };
					});
					const summary: SchemaSummary = {
						type: 'prisma',
						file: prismaUri.toString(true),
						models
					};
					this.appendMetadataArray(builder, applicationKey, 'databaseSchemas', summary);
					builder.addEvidence(applicationKey, {
						description: `Prisma schema defining ${models.length} model${models.length === 1 ? '' : 's'}`,
						resource: prismaUri,
						snippet: models.slice(0, 2).map(model => `model ${model.name} { … }`).join('\n'),
						confidence: 0.6
					});
					builder.addSummary(`Detected Prisma schema in ${folder.name ?? this.context.extUri.basename(folder.uri)}`);
					for (const model of models) {
						const datasetKey = this.ensureDatasetComponent(builder, applicationKey, {
							category: 'model',
							name: model.name,
							technology: 'Prisma',
							schemaFile: prismaUri.toString(true),
							fields: model.fields,
							source: prismaUri
						});
						if (!datasetKey) {
							continue;
						}
						this.registerDataset(applicationKey, datasetKey, `${model.name} Model`);
						builder.addEvidence(datasetKey, {
							description: `Model ${model.name} defined in Prisma schema`,
							resource: prismaUri,
							snippet: `model ${model.name} { … }`,
							confidence: 0.5
						});
						this.linkDatasetToBackends(builder, applicationKey, datasetKey, 0.55, {
							description: `Schema ${model.name}`,
							resource: prismaUri,
							confidence: 0.5
						});
					}
				}
			}

			const sqlFiles = await this.collectSqlFiles(folder.uri, 10);
			for (const sqlUri of sqlFiles) {
				const sqlBuffer = await this.tryReadFile(sqlUri);
				if (!sqlBuffer) {
					continue;
				}
				const sqlText = sqlBuffer.toString();
				const tables: Array<{ name: string; columns: string[] }> = [];
				const tableRegex = /create\s+table\s+[`"']?([\w-]+)[`"']?\s*\(([\s\S]*?)\);/gi;
				let tableMatch: RegExpExecArray | null;
				while ((tableMatch = tableRegex.exec(sqlText)) !== null) {
					const columns = tableMatch[2]
						.split(/\r?\n/)
						.map(line => line.trim())
						.filter(line => !!line && !/^\)/.test(line))
						.slice(0, 12);
					tables.push({ name: tableMatch[1], columns });
				}
				if (tables.length) {
					const summary: SchemaSummary = {
						type: 'sql',
						file: sqlUri.toString(true),
						tables
					};
					this.appendMetadataArray(builder, applicationKey, 'databaseSchemas', summary);
					builder.addEvidence(applicationKey, {
						description: `SQL schema defining ${tables.length} table${tables.length === 1 ? '' : 's'}`,
						resource: sqlUri,
						snippet: tables.slice(0, 2).map(table => `CREATE TABLE ${table.name} (...)`).join('\n'),
						confidence: 0.55
					});
					for (const table of tables) {
						const datasetKey = this.ensureDatasetComponent(builder, applicationKey, {
							category: 'table',
							name: table.name,
							technology: 'SQL',
							schemaFile: sqlUri.toString(true),
							columns: table.columns,
							source: sqlUri
						});
						if (!datasetKey) {
							continue;
						}
						this.registerDataset(applicationKey, datasetKey, `${table.name} Table`);
						builder.addEvidence(datasetKey, {
							description: `Table ${table.name} defined in SQL schema`,
							resource: sqlUri,
							snippet: `CREATE TABLE ${table.name} (...)`,
							confidence: 0.5
						});
						this.linkDatasetToBackends(builder, applicationKey, datasetKey, 0.5, {
							description: `SQL schema ${table.name}`,
							resource: sqlUri,
							confidence: 0.5
						});
					}
				}
			}
			const appLabel = this.getApplicationLabel(applicationKey);
			const datasetCountForApp = this.datasetCounts.get(applicationKey) ?? 0;
			this.logService.debug('[ArchitectureAnalyzer] dataset count', appLabel, datasetCountForApp);
		}
	}

	private async detectGraphQLOperations(builder: ArchitectureModelBuilder): Promise<void> {
		const folderQueries = this.context.getWorkspaceFolders().map(folder => ({ folder: folder.uri }));
		if (!folderQueries.length) {
			return;
		}
		const fileMatches = new Map<string, URI>();
		const searchResult = await this.searchService.textSearch({
			type: QueryType.Text,
			folderQueries,
			contentPattern: { pattern: 'gql`', isRegExp: false },
			excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
			maxResults: 200
		}, CancellationToken.None, (progress: ISearchProgressItem) => {
			if (!progress || !isFileMatch(progress) || !progress.results) {
				return;
			}
			const key = progress.resource.toString();
			if (!fileMatches.has(key)) {
				fileMatches.set(key, progress.resource);
			}
		});
		if (searchResult?.limitHit) {
			builder.addWarning('GraphQL detection reached the search limit; some operations may be omitted.');
		}

		for (const uri of fileMatches.values()) {
			const text = await this.getFileText(uri);
			if (!text) {
				continue;
			}
			const operations: GraphQLOperationSummary[] = [];
			const regex = /gql`([\s\S]*?)`/g;
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				const body = match[1];
				const headerMatch = /(query|mutation|subscription)\s*(\w+)?/i.exec(body);
				operations.push({
					type: headerMatch ? headerMatch[1] : 'query',
					name: headerMatch && headerMatch[2] ? headerMatch[2] : undefined,
					file: uri.toString(true),
					snippet: body.slice(0, 200)
				});
				if (operations.length >= 5) {
					break;
				}
			}
			if (!operations.length) {
				continue;
			}
			const componentKey = this.inferComponentForResource(uri) ?? this.findApplicationKeyForResource(uri);
			if (!componentKey) {
				continue;
			}
			for (const operation of operations) {
				builder.addEvidence(componentKey, {
					description: `GraphQL ${operation.type.toUpperCase()} ${operation.name ?? '<anonymous>'}`,
					resource: uri,
					snippet: operation.snippet,
					confidence: 0.45
				});
				this.appendMetadataArray(builder, componentKey, 'graphqlOperations', operation);
			}
		}
	}

	private async detectSqlQueries(builder: ArchitectureModelBuilder): Promise<void> {
		const folderQueries = this.context.getWorkspaceFolders().map(folder => ({ folder: folder.uri }));
		if (!folderQueries.length) {
			return;
		}
		const matches: Array<{ uri: URI; text: string }> = [];
		const searchResult = await this.searchService.textSearch({
			type: QueryType.Text,
			folderQueries,
			excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
			contentPattern: {
				pattern: '\\bselect\\b[\n\r\t\s]+[\s\S]{0,200}?\\bfrom\\b',
				isRegExp: true,
				isCaseSensitive: false,
				isMultiline: true
			}
		}, CancellationToken.None, (progress: ISearchProgressItem) => {
			if (!progress || !isFileMatch(progress) || !progress.results) {
				return;
			}
			for (const result of progress.results) {
				if (!resultIsMatch(result)) {
					continue;
				}
				matches.push({ uri: progress.resource, text: result.previewText });
			}
		});
		if (searchResult?.limitHit) {
			builder.addWarning('SQL query detection reached the search limit; some query edges may be omitted.');
		}

		let queryIndex = 0;
		for (const match of matches.slice(0, 200)) {
			const applicationKey = this.findApplicationKeyForResource(match.uri);
			const sourceKey = this.inferComponentForResource(match.uri) ?? applicationKey;
			if (!applicationKey || !sourceKey) {
				continue;
			}
			const tableMatch = /from\s+([\w`"\.]+)/i.exec(match.text);
			const tableName = tableMatch ? tableMatch[1].replace(/[`"']/g, '') : undefined;
			builder.addEvidence(sourceKey, {
				description: `SQL query${tableName ? ` on ${tableName}` : ''}`,
				resource: match.uri,
				snippet: match.text.trim(),
				confidence: 0.4
			});
			this.appendMetadataArray(builder, sourceKey, 'sqlQueries', {
				table: tableName,
				file: match.uri.toString(true),
				snippet: match.text.trim()
			});
			if (tableName) {
				const datasetKey = this.ensureDatasetComponent(builder, applicationKey, {
					category: 'table',
					name: tableName,
					technology: 'SQL'
				});
				if (datasetKey) {
					this.registerDataset(applicationKey, datasetKey, `${tableName} Table`);
					const relationshipKey = `queries:${sourceKey}->${datasetKey}:${queryIndex++}`;
					builder.ensureRelationship(relationshipKey, () => ({
						source: sourceKey,
						target: datasetKey,
						kind: 'queries',
						confidence: 0.45,
						description: `Queries ${tableName}`,
						metadata: {
							sql: {
								table: tableName,
								file: match.uri.toString(true),
								snippet: match.text.trim()
							}
						},
						evidence: [
							{ description: `SQL query on ${tableName}`, resource: match.uri, snippet: match.text.trim(), confidence: 0.4 }
						]
					}));
					this.appendMetadataArray(builder, datasetKey, 'queries', {
						source: sourceKey,
						file: match.uri.toString(true),
						snippet: match.text.trim()
					});
					builder.addEvidence(datasetKey, {
						description: `Queried via ${sourceKey}`,
						resource: match.uri,
						snippet: match.text.trim(),
						confidence: 0.35
					});
					this.linkDatasetToBackends(builder, applicationKey, datasetKey, 0.45, {
						description: `Query from ${sourceKey}`,
						resource: match.uri,
						snippet: match.text.trim(),
						confidence: 0.35
					});
				}
			}
		}
		this.logService.debug('[ArchitectureAnalyzer] SQL query samples analyzed', Math.min(matches.length, 200));
	}

	private inferComponentForResource(resource: URI): string | undefined {
		const path = resource.path.toLowerCase();
		const applicationKey = this.findApplicationKeyForResource(resource);
		if (!applicationKey) {
			return undefined;
		}
		if (/client|frontend|\.(tsx|jsx|vue|svelte)$/.test(path)) {
			return `frontend:inferred:${applicationKey}`;
		}
		if (/server|backend|api|functions?|lambda|\.(ts|js|go|py)$/.test(path)) {
			return `backend:inferred:${applicationKey}`;
		}
		return applicationKey;
	}

	private extractHost(url: string): string | undefined {
		try {
			const match = /https?:\/\/([^/]+)/.exec(url);
			return match?.[1];
		} catch (error) {
			this.logService.debug('[ArchitectureAnalyzer] failed to parse host', url, error);
			return undefined;
		}
	}

	private hasDependency(dependencies: Record<string, string>, name: string): boolean {
		return Object.prototype.hasOwnProperty.call(dependencies, name);
	}

	private ensureDatasetComponent(
		builder: ArchitectureModelBuilder,
		applicationKey: string,
		dataset: {
			category: 'model' | 'table';
			name: string;
			technology: string;
			schemaFile?: string;
			fields?: Array<{ name: string; type: string }>;
			columns?: string[];
			source?: URI;
		}
	): string | undefined {
		const datasetKey = this.getDatasetKey(applicationKey, dataset.category, dataset.name);
		const isExistingDataset = this.datasetKeys.has(datasetKey);
		if (!isExistingDataset) {
			const currentCount = this.datasetCounts.get(applicationKey) ?? 0;
			if (currentCount >= this.datasetLimitPerApp) {
				if (!this.datasetLimitWarned.has(applicationKey)) {
					const appLabel = this.getApplicationLabel(applicationKey);
					builder.addWarning(`Dataset sampling limited to ${this.datasetLimitPerApp} entries for ${appLabel}; additional datasets are omitted.`);
					this.logService.warn('[ArchitectureAnalyzer] dataset limit reached', appLabel, this.datasetLimitPerApp);
					this.datasetLimitWarned.add(applicationKey);
				}
				return undefined;
			}
		}
		const labelSuffix = dataset.category === 'model' ? 'Model' : 'Table';
		builder.ensureComponent(datasetKey, () => ({
			kind: 'dataset',
			label: `${dataset.name} ${labelSuffix}`,
			description: dataset.category === 'model' ? 'Application data model' : 'Database table',
			confidence: 0.45,
			technology: dataset.technology,
			tags: ['dataset', dataset.category],
			metadata: {
				datasetType: dataset.category,
				application: applicationKey,
				schemaFile: dataset.schemaFile,
				fields: dataset.fields,
				columns: dataset.columns
			},
			evidence: []
		}));
		builder.augmentComponent(datasetKey, component => {
			component.tags = [...new Set([...(component.tags ?? []), 'dataset', dataset.category])];
			component.confidence = Math.max(component.confidence, 0.45);
			const metadata = component.metadata as Record<string, unknown>;
			metadata.datasetType = dataset.category;
			metadata.application = applicationKey;
			if (dataset.schemaFile) {
				metadata.schemaFile = dataset.schemaFile;
			}
			if (dataset.fields?.length) {
				metadata.fields = dataset.fields;
			}
			if (dataset.columns?.length) {
				metadata.columns = dataset.columns;
			}
		});
		if (!isExistingDataset) {
			this.datasetKeys.add(datasetKey);
			this.datasetCounts.set(applicationKey, (this.datasetCounts.get(applicationKey) ?? 0) + 1);
		}
		const relationshipKey = `stores:${applicationKey}->${datasetKey}`;
		builder.ensureRelationship(relationshipKey, () => ({
			source: applicationKey,
			target: datasetKey,
			kind: 'stores',
			confidence: 0.5,
			description: `Stores data in ${dataset.name}`,
			metadata: {
				dataset: {
					name: dataset.name,
					type: dataset.category,
					schemaFile: dataset.schemaFile
				}
			},
			evidence: dataset.source
				? [{ description: `${dataset.name} schema`, resource: dataset.source, confidence: 0.45 }]
				: []
		}));
		return datasetKey;
	}

	private getDatasetKey(applicationKey: string, category: 'model' | 'table', name: string): string {
		const normalizedName = name.replace(/\s+/g, '_').toLowerCase();
		return `dataset:${applicationKey}:${category}:${normalizedName}`;
	}

	private getApplicationLabel(applicationKey: string): string {
		if (!applicationKey.startsWith('application:')) {
			return applicationKey;
		}
		const rawUri = applicationKey.slice('application:'.length);
		try {
			const uri = URI.parse(rawUri);
			const matchingFolder = this.context.getWorkspaceFolders().find(folder => this.context.extUri.isEqual(folder.uri, uri));
			return matchingFolder?.name ?? this.context.extUri.basename(uri);
		} catch (error) {
			this.logService.debug('[ArchitectureAnalyzer] failed to parse application key', applicationKey, error);
			return rawUri;
		}
	}

	private parseHttpSnippet(snippet: string, label: string): { method?: string; url?: string } {
		const axiosCall = /axios\s*\.\s*(get|post|put|delete|patch|request)\s*\(\s*(['"`])([^'"`]+)\2/i.exec(snippet);
		if (axiosCall) {
			return { method: axiosCall[1].toUpperCase(), url: axiosCall[3] };
		}
		const fetchCall = /fetch\s*\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*(\{[\s\S]*?\}))?/i.exec(snippet);
		if (fetchCall) {
			const details: { method?: string; url?: string } = { url: fetchCall[2] };
			if (fetchCall[3]) {
				const methodMatch = /method\s*:\s*(['"`])([A-Z]+)\1/i.exec(fetchCall[3]);
				if (methodMatch) {
					details.method = methodMatch[2].toUpperCase();
				}
			}
			return details;
		}
		const clientCall = /httpClient\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(['"`])([^'"`]+)\2/i.exec(snippet);
		if (clientCall) {
			return { method: clientCall[1].toUpperCase(), url: clientCall[3] };
		}
		const urlProp = /url\s*:\s*(['"`])([^'"`]+)\1/.exec(snippet);
		const methodProp = /method\s*:\s*(['"`])([A-Z]+)\1/.exec(snippet);
		if (urlProp || methodProp) {
			return {
				method: (methodProp ? methodProp[2] : label).toUpperCase(),
				url: urlProp ? urlProp[2] : undefined
			};
		}
		return { method: label.toUpperCase(), url: undefined };
	}

	private appendMetadataArray(builder: ArchitectureModelBuilder, componentKey: string | undefined, key: string, entry: unknown): void {
		if (!componentKey) {
			return;
		}
		builder.augmentComponent(componentKey, component => {
			const metadata = component.metadata as Record<string, unknown>;
			const existing = metadata[key];
			if (Array.isArray(existing)) {
				existing.push(entry);
			} else {
				metadata[key] = [entry];
			}
		});
	}

	private registerBackend(applicationKey: string, backendKey: string, label: string): void {
		this.componentToApplication.set(backendKey, applicationKey);
		this.componentLabels.set(backendKey, label);
		let set = this.backendsByApplication.get(applicationKey);
		if (!set) {
			set = new Set<string>();
			this.backendsByApplication.set(applicationKey, set);
		}
		set.add(backendKey);
	}

	private registerFrontend(applicationKey: string, frontendKey: string, label: string): void {
		this.componentToApplication.set(frontendKey, applicationKey);
		this.componentLabels.set(frontendKey, label);
		let set = this.frontendsByApplication.get(applicationKey);
		if (!set) {
			set = new Set<string>();
			this.frontendsByApplication.set(applicationKey, set);
		}
		set.add(frontendKey);
	}

	private registerDataset(applicationKey: string, datasetKey: string, label: string): void {
		this.componentToApplication.set(datasetKey, applicationKey);
		this.componentLabels.set(datasetKey, label);
	}

	private getBackendsForApplication(applicationKey: string | undefined): string[] {
		if (!applicationKey) {
			return [];
		}
		const set = this.backendsByApplication.get(applicationKey);
		return set ? Array.from(set) : [];
	}

	private getApplicationForComponent(componentKey: string | undefined): string | undefined {
		if (!componentKey) {
			return undefined;
		}
		return this.componentToApplication.get(componentKey);
	}

	private linkDatasetToBackends(
		builder: ArchitectureModelBuilder,
		applicationKey: string,
		datasetKey: string,
		confidence: number,
		evidence?: DetectionEvidence
	): void {
		const backends = this.getBackendsForApplication(applicationKey);
		if (!backends.length) {
			const warningKey = `${applicationKey}:${datasetKey}`;
			if (!this.datasetMissingBackendWarned.has(warningKey)) {
				this.datasetMissingBackendWarned.add(warningKey);
				const appLabel = this.getApplicationLabel(applicationKey);
				builder.addWarning(`Detected dataset for ${appLabel} but no backend service was identified to link.`);
			}
			return;
		}
		const datasetLabel = this.componentLabels.get(datasetKey) ?? 'Dataset';
		for (const backendKey of backends) {
			const backendLabel = this.componentLabels.get(backendKey) ?? 'Backend Service';
			const relationshipKey = `stores:${backendKey}->${datasetKey}`;
			builder.ensureRelationship(relationshipKey, () => ({
				source: backendKey,
				target: datasetKey,
				kind: 'stores',
				confidence: Math.max(confidence, 0.45),
				description: `${backendLabel} stores data in ${datasetLabel}`,
				metadata: { link: 'dataset' },
				evidence: evidence ? [evidence] : []
			}));
		}
	}

	private isLocalHost(host: string | undefined): boolean {
		if (!host) {
			return false;
		}
		const normalized = host.toLowerCase();
		return normalized === 'localhost'
			|| normalized === '0.0.0.0'
			|| normalized === '::1'
			|| normalized.startsWith('127.')
			|| normalized.endsWith('.local');
	}

	private resolveInternalBackend(sourceKey: string | undefined, applicationKey: string | undefined, host: string | undefined, url: string): string | undefined {
		const candidateApplication = applicationKey ?? this.getApplicationForComponent(sourceKey);
		if (!candidateApplication) {
			return undefined;
		}
		const backends = this.getBackendsForApplication(candidateApplication);
		if (!backends.length) {
			return undefined;
		}
		const isRelative = /^\.|^\//.test(url ?? '');
		if (isRelative || this.isLocalHost(host)) {
			return backends[0];
		}
		return undefined;
	}

	private async getFileText(uri: URI): Promise<string | undefined> {
		const cached = this.textCache.get(uri);
		if (cached !== undefined) {
			return cached;
		}
		const buffer = await this.tryReadFile(uri);
		const text = buffer?.toString();
		if (text !== undefined) {
			this.textCache.set(uri, text);
		}
		return text;
	}

	private async collectSqlFiles(folder: URI, max: number): Promise<URI[]> {
		const results: URI[] = [];
		const searchResult = await this.searchService.fileSearch({
			type: QueryType.File,
			folderQueries: [{ folder }],
			filePattern: '*.sql',
			excludePattern: GRAPH_DEFAULT_EXCLUDE_GLOBS,
			maxResults: max
		});
		for (const entry of searchResult.results) {
			const resource = (entry as IFileMatch).resource;
			if (resource) {
				results.push(resource);
			}
		}
		return results.slice(0, max);
	}

	private async queryWorkspaceSymbols(query: string, max = 200): Promise<WorkspaceSymbolLike[]> {
		try {
			const result = await this.commandService.executeCommand<WorkspaceSymbolLike[]>('vscode.executeWorkspaceSymbolProvider', query);
			if (!Array.isArray(result)) {
				return [];
			}
			return result.slice(0, max);
		} catch (error) {
			this.logService.debug('[ArchitectureAnalyzer] workspace symbol query failed', query, error);
			return [];
		}
	}

	private async tryReadFile(uri: URI): Promise<VSBuffer | undefined> {
		try {
			const stat = await this.fileService.readFile(uri);
			return stat.value;
		} catch (error) {
			if (error instanceof FileSystemProviderError && error.code === FileSystemProviderErrorCode.FileNotFound) {
				return undefined;
			}
			return undefined;
		}
	}
}


