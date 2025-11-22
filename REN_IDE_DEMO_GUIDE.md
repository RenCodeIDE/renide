# Ren IDE - Complete Product Demo Guide

## Overview

**Ren IDE** is a fork of VS Code (Code - OSS) with advanced code intelligence features. It provides:
- **Graph View**: Visualize code dependencies and architecture
- **MonitorX**: AI-powered changelog and workspace monitoring
- **Docs System**: Automatic documentation generation from code chunks
- **Merkle Tree System**: Efficient code change tracking with chunk-level granularity

---

## Configuration & Setup

### Environment Variables

Ren IDE uses environment variables for configuration. The application automatically loads a `.env` file from the app root or current working directory.

#### SERVER_ADDRESS Configuration

**Required**: Set the `SERVER_ADDRESS` environment variable to point to your Ren server.

**Configuration Options:**

1. **Create a `.env` file** in the project root:
   ```bash
   # .env file
   SERVER_ADDRESS=http://localhost:8787
   ```

2. **Set as environment variable**:
   ```bash
   export SERVER_ADDRESS=http://localhost:8787
   ```

**Important Notes:**
- Use the **base URL only** (without `/api` suffix)
- The application automatically appends `/api` to endpoints
- Endpoints like `/api/auth/login`, `/api/agent/tools` are constructed automatically
- The code includes normalization logic that handles both formats, but using the base URL is recommended

**Example Configurations:**
```bash
# Local development
SERVER_ADDRESS=http://localhost:8787

# Production
SERVER_ADDRESS=https://your-ren-server.com

# With custom port
SERVER_ADDRESS=http://localhost:3000
```

**How It Works:**
- The `.env` file is automatically loaded from the app root or current working directory
- Environment variables are passed to both the main process and renderer processes
- The `RenApiClient` and chat agents use `SERVER_ADDRESS` to construct API endpoints
- If `SERVER_ADDRESS` is not set, the application falls back to `apiBaseUrl` from `product.json`

**Authentication:**
- After setting `SERVER_ADDRESS`, use the "Ren: Sign In" command from the Command Palette
- Authentication tokens are stored securely in VS Code's secret storage
- The `ren.auth.accessToken` is used for authenticated API requests

**File Locations:**
- Environment loading: `src/vs/code/electron-main/main.ts` (lines 243-286)
- API client: `src/vs/workbench/services/renAuth/common/renApiClient.ts`
- Chat agents: `src/vs/workbench/contrib/chat/browser/gemini/contribution.ts` and `src/vs/workbench/contrib/chat/browser/chatgpt/contribution.ts`

---

## 1. Core Architecture & Implementation

### What is Ren IDE?

Ren IDE is built on VS Code's foundation with these key additions:
- **Ren Views System**: Custom view modes (Code, MonitorX, Graph)
- **Merkle Tree Service**: Chunked file hashing for change detection
- **Graph Data Builder**: Dependency graph generation engine
- **Architecture Analyzer**: Multi-language architecture detection
- **Docs Service**: Automated documentation generation

### Key Files & Locations

- **Product Configuration**: `product.json` (defines "Ren IDE" branding)
- **Ren Views**: `src/vs/workbench/contrib/renViews/`
- **Merkle Tree**: `src/vs/platform/merkleTree/`
- **Graph View**: `src/vs/workbench/contrib/renViews/browser/views/graphView/`
- **Architecture Analyzer**: `src/vs/workbench/contrib/renViews/browser/views/graphView/architectureAnalyzer.ts`

---

## 2. Code Chunking System

### How Code is Divided into Chunks

**Chunking Strategy:**
- Files are split into **200-line chunks** (configurable)
- Each chunk is independently hashed using SHA256
- Chunks are created by splitting on line boundaries
- Default chunk size: `chunkSizeLines: 200`

**Example:**
```typescript
// A 600-line file becomes:
[
  { startLine: 0, endLine: 200, hash: "abc123..." },    // Chunk 1
  { startLine: 200, endLine: 400, hash: "def456..." },  // Chunk 2
  { startLine: 400, endLine: 600, hash: "ghi789..." }   // Chunk 3
]
```

### Chunking Algorithm

**Location**: `src/vs/platform/merkleTree/common/merkleTreeBuilder.ts`

**Process:**
1. Read entire file content
2. Split content by line breaks (`\r?\n`)
3. Create chunks of 200 lines each
4. Hash each chunk independently using SHA256
5. Link chunks sequentially using `parentHash` (each chunk points to previous chunk's hash)
6. Combine all chunk hashes into a single file hash

**Key Benefits:**
- **Granular Change Detection**: Only changed chunks are recalculated
- **Smart Caching**: Cache invalidation at chunk level
- **Incremental Updates**: Process only what changed
- **Performance**: Avoid re-processing unchanged chunks

### How Chunks Are Connected

**Important Distinction**: There are TWO different types of "parent" relationships:

**1. Merkle Tree Parent (File Node)**
- In the Merkle tree, the **FILE NODE** is the parent of chunks
- Chunks are stored as data (`chunks: FileChunk[]`) inside the file node
- The file node's hash is computed from all its chunks
- Chunks are NOT tree nodes themselves - they're just data stored in file nodes

**2. Sequential Connection (parentHash) - Within File**
- Each chunk has a `parentHash` field that points to the **previous chunk's hash**
- This creates a **linked list** structure within the file: Chunk 1 → Chunk 2 → Chunk 3 → ...
- The first chunk has no `parentHash` (undefined)
- `parentHash` represents **sequential ordering within the file**, not Merkle tree hierarchy
- When a chunk's content changes, its hash changes, but the `parentHash` relationships remain the same (unless chunks are reordered)

**Example:**
```typescript
// File with 600 lines becomes 3 chunks:
Chunk 1 (lines 0-199):
  - hash: "abc123..."
  - parentHash: undefined  // First chunk, no parent

Chunk 2 (lines 200-399):
  - hash: "def456..."
  - parentHash: "abc123..."  // Points to Chunk 1's hash

Chunk 3 (lines 400-599):
  - hash: "ghi789..."
  - parentHash: "def456..."  // Points to Chunk 2's hash
```

**2. Hierarchical Connection (children)**
- Chunks can have a `children` array containing child chunk hashes
- This enables **semantic grouping** of chunks (e.g., a parent chunk representing a function, with child chunks representing nested functions)
- Currently less commonly used, but available for future semantic analysis
- Allows building hierarchical relationships beyond sequential order

**Example:**
```typescript
// A chunk representing a class might have children:
Chunk (Class Definition):
  - hash: "class123..."
  - children: ["method1hash...", "method2hash..."]  // Child chunks for methods
```

**Visual Representation:**

**Merkle Tree Hierarchy:**
```
Workspace Root
  └── src/ (directory node)
      └── utils.ts (FILE NODE) ← Parent of chunks in Merkle tree
          chunks: [
            Chunk 1,
            Chunk 2,
            Chunk 3
          ]
```

**Sequential Connection (parentHash) - Within File:**
```
File Node: utils.ts
  │
  └── chunks: [
        ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
        │  Chunk 1    │ ───▶ │  Chunk 2    │ ───▶ │  Chunk 3    │
        │ lines 0-199 │      │ lines 200-399│      │ lines 400-599│
        │ hash: abc123│      │ hash: def456 │      │ hash: ghi789 │
        │ parentHash: │      │ parentHash:  │      │ parentHash:  │
        │  undefined  │      │   "abc123"   │      │   "def456"   │
        └─────────────┘      └─────────────┘      └─────────────┘
           (first chunk)         (middle)           (last chunk)
      ]
```

**Complete Structure:**
```
Merkle Tree Level:
  Directory Node (src/)
    └── File Node (utils.ts) ← PARENT of chunks
        │
        └── chunks: [Chunk 1, Chunk 2, Chunk 3]  ← Stored as data, not tree nodes

Sequential Level (within chunks):
  Chunk 1 → Chunk 2 → Chunk 3  (via parentHash)
```

**How parentHash is Set:**
```typescript
// In merkleTreeBuilder.ts (line 476-493)
let previousHash: string | undefined;
for (let startLine = 0; startLine < totalLines; startLine += chunkSizeLines) {
  const chunkHash = await hashString(chunkContent);

  chunks.push({
    startLine,
    endLine,
    hash: chunkHash,
    parentHash: previousHash,  // Link to previous chunk
  });

  previousHash = chunkHash;  // Set for next iteration
}
```

**Key Points:**

**Merkle Tree Level:**
- **File node is the parent** of chunks in the Merkle tree
- Chunks are stored as an array (`chunks: FileChunk[]`) inside file nodes
- File node's hash = `hash(all chunk hashes combined)`
- Directory node's hash = `hash(all child node hashes combined)`
- Chunks are NOT tree nodes - they're just data

**Sequential Level (within file):**
- **Sequential (`parentHash`)**: Always present, represents file order
- **Hierarchical (`children`)**: Optional, represents semantic relationships
- Both relationships can coexist in the same chunk
- `parentHash` doesn't change when chunk content changes (only when order changes)
- `parentHash` enables traversal: start from any chunk and go backwards through the file
- When Chunk 2's content changes, its hash changes, but Chunk 3's `parentHash` still points to Chunk 2 (the relationship remains)

**Hash Computation:**
```typescript
// File node hash is computed from chunks:
fileNode.hash = hash(`chunks:${chunk1.hash}|${chunk2.hash}|${chunk3.hash}`)

// Directory node hash is computed from children:
directoryNode.hash = hash(`dir:${path}:${child1.hash}|${child2.hash}|...`)
```

---

## 3. Merkle Tree System

### What is a Merkle Tree?

A **Merkle Tree** is a hierarchical data structure where:
- **Leaf nodes** = File nodes (with SHA256 hashes computed from chunks)
- **Internal nodes** = Directory nodes (hashes computed from children)
- **Root node** = Workspace state hash (single hash representing entire workspace)
- **Chunks** = Data stored inside file nodes (NOT tree nodes themselves)

### Merkle Tree Structure

**Important**: Chunks are NOT nodes in the Merkle tree. They are stored as data inside file nodes.

```
Workspace Root (rootHash)
  │
  ├── src/ (directory node)
  │   │   hash: computed from children
  │   │   type: 'directory'
  │   │   children: [file1Node, file2Node, ...]
  │   │
  │   ├── file1.ts (file node) ← PARENT of chunks in Merkle tree
  │   │   hash: computed from chunks
  │   │   type: 'file'
  │   │   fileHash: "file1hash..."
  │   │   chunks: [                    ← Chunks stored here (NOT tree nodes)
  │   │     { hash: "abc123...", parentHash: undefined },      // Chunk 1
  │   │     { hash: "def456...", parentHash: "abc123..." },    // Chunk 2
  │   │     { hash: "ghi789...", parentHash: "def456..." }     // Chunk 3
  │   │   ]
  │   │
  │   └── file2.ts (file node)
  │       hash: computed from chunks
  │       type: 'file'
  │       chunks: [
  │         { hash: "xyz999...", parentHash: undefined }
  │       ]
  │
  └── package.json (file node)
      hash: computed from chunks
      chunks: [...]
```

**Key Points:**
- **File nodes** are the leaf nodes in the Merkle tree
- **Directory nodes** are internal nodes that contain file nodes as children
- **Chunks are NOT tree nodes** - they're stored as an array (`chunks`) inside file nodes
- **The FILE node is the parent of chunks** in the Merkle tree structure
- File node's hash is computed from its chunks: `hash(chunk1.hash + chunk2.hash + ...)`
- Directory node's hash is computed from its children: `hash(child1.hash + child2.hash + ...)`

### Key Features

**1. Incremental Updates**
- Only changed chunks are recalculated
- Parent directory hashes update automatically
- Root hash changes only when workspace changes

**2. Smart Caching**
- LRU cache for tree nodes (default: 10,000 nodes)
- Persistence to workspace storage (saved every 30 seconds)
- Automatic garbage collection (evicts unused nodes after 5 minutes)

**3. Change Detection**
- Monitors file system events (added, deleted, modified)
- Tracks editor changes (open files, undo/redo)
- Debounced updates (100ms) to batch rapid changes

**4. Repository Size Optimization**
- **Small repos** (< 10k files): Full tree tracking
- **Medium repos** (10k-50k files): Sparse tree tracking
- **Large repos** (50k-500k files): Directory-level hashing
- **Massive repos** (> 500k files): Ultra-sparse tracking

### API Methods

**Location**: `src/vs/platform/merkleTree/common/merkleTreeService.ts`

**Key Methods:**
- `getTree()`: Get complete tree structure
- `getFileChunks(relativePath)`: Get all chunks for a file
- `getChangedChunks(relativePath, oldChunks)`: Compare chunks to find changes
- `getChangeLog(since?)`: Get change log since timestamp
- `getSnapshot(version?)`: Get tree snapshot at specific version
- `rootHash`: Current workspace state hash (read-only)

### Configuration

```json
{
  "merkleTree": {
    "enabled": true,
    "lazyTracking": true,              // Only track actively used files
    "excludeStaticDirs": true,          // Exclude node_modules, .git, etc.
    "cacheSize": 10000,                 // LRU cache size
    "memoryLimitMB": 100,               // Memory limit in MB
    "chunkSizeLines": 200,              // Lines per chunk
    "enableChunkedHashing": true        // Enable chunked hashing
  }
}
```

---

## 4. Graph Generation

### How Graphs are Generated

**Location**: `src/vs/workbench/contrib/renViews/browser/views/graphView/graphDataBuilder.ts`

### Graph Modes

**1. File Graph Mode**
- Shows import dependencies for a single file
- Traverses imports recursively (BFS)
- Resolves import specifiers (`.ts`, `.tsx`, `.js`, etc.)
- Handles circular dependencies
- Caches parsed imports and resolved paths

**2. Folder/Workspace Graph Mode**
- Shows dependencies for a folder or entire workspace
- Collects all files in scope
- Builds comprehensive dependency graph
- Filters excluded paths (node_modules, .git, etc.)

**3. Architecture Graph Mode**
- Automatically detects application architecture
- Identifies: applications, frontends, backends, databases, external services
- Detects data flows (which services query which databases)
- Multi-language support (JavaScript, TypeScript, Python, Go, Rust)

**4. Data Flow Graph Mode**
- Shows function call graphs
- Traces data flow through function calls
- Supports upstream/downstream analysis
- Configurable depth (default: 10 levels)

**5. Git Heatmap Mode**
- Visualizes file co-change patterns from Git history
- Groups files by commit frequency
- Shows which files change together
- Configurable time windows (60, 90, 120, 180 days)

### Graph Building Process

**Step 1: File Collection**
```typescript
// Collect files in scope
const files = await this.collectFilesInScope(folders);
// Filters: excludes node_modules, .git, build outputs, etc.
```

**Step 2: Import Parsing**
```typescript
// Parse imports from each file
const descriptors = await this.getImportDescriptors(fileUri);
// Uses language server or regex-based parsing
// Caches results to avoid duplicate work
```

**Step 3: Import Resolution**
```typescript
// Resolve import specifiers to actual file paths
const resolvedUri = await this.resolveImportTarget(sourceUri, specifier);
// Tries: .ts, .tsx, .js, .jsx, .mjs, .cjs, index files
// Caches resolved paths
```

**Step 4: Graph Traversal (BFS)**
```typescript
// Breadth-first search to build dependency graph
const queue = [initialFiles];
const processed = new Set();
while (queue.length) {
  const fileUri = queue.shift();
  // Parse imports, resolve paths, add to queue
  // Track processed files to avoid cycles
}
```

**Step 5: Node & Edge Creation**
```typescript
// Create graph nodes (files)
const nodes = files.map(file => ({
  id: toCytoscapeId(file),
  label: basename(file),
  path: file.toString(),
  weight: importCount,  // Size based on imports/exports
  // ... metadata
}));

// Create graph edges (dependencies)
const edges = imports.map(imp => ({
  id: `${source}->${target}`,
  source: sourceId,
  target: targetId,
  label: importSpecifier,
  // ... metadata
}));
```

### Architecture Detection

**Location**: `src/vs/workbench/contrib/renViews/browser/views/graphView/architectureAnalyzer.ts`

**Detection Steps:**
1. **Baseline Applications**: Detect React apps, Python services, Go services
2. **Node Ecosystem**: Analyze `package.json`, `npm` dependencies
3. **Python Ecosystem**: Analyze `requirements.txt`, `pyproject.toml`
4. **Go Ecosystem**: Analyze `go.mod` files
5. **Rust Ecosystem**: Analyze `Cargo.toml` files
6. **Docker Compose**: Detect container orchestration
7. **Database Schemas**: Parse SQL files, migrations
8. **GraphQL Operations**: Scan `.graphql` files
9. **Workspace Symbols**: Use language server symbols
10. **HTTP Clients**: Pattern match `fetch`, `axios`, etc.
11. **SQL Queries**: Extract SQL queries from code

**Component Types:**
- `application`: Main applications (React apps, services)
- `frontend`: Frontend components
- `backend`: Backend services
- `database`: Databases and schemas
- `cache`: Caching layers (Redis, etc.)
- `queue`: Message queues
- `messageBus`: Message bus systems
- `externalService`: External APIs
- `infrastructure`: Infrastructure components
- `dataset`: Data sources

**Relationship Types:**
- `hosts`: Application hosts component
- `dependsOn`: Component depends on another
- `connectsTo`: Component connects to another
- `calls`: Component calls another (HTTP/RPC)
- `publishes`: Component publishes to queue
- `consumes`: Component consumes from queue
- `queries`: Component queries database

### Graph Visualization

**Library**: Cytoscape.js (included in `src/vs/workbench/contrib/renViews/browser/media/cytoscape.min.js`)

**Features:**
- Interactive node selection
- Zoom in/out
- Node sizing by imports/exports
- Color coding by category
- Edge highlighting
- Legend with category filters
- Heatmap visualization (Git co-change patterns)

---

## 5. Documentation System

### How Docs are Generated

**Location**: `src/vs/workbench/contrib/renViews/browser/services/docsService.ts`

### Three-Layer System

**Layer 1: Merkle Tree Service**
- Source of truth for file chunks
- Tracks file system changes
- Provides chunk hashes

**Layer 2: Chunk Index Service**
- Stores chunk metadata
- Tracks parentHash (sequential links)
- Tracks children (hierarchical links)
- Extracts symbols from each chunk

**Layer 3: Docs Service**
- Generates markdown docs for chunks
- Stores generated docs in workspace storage
- Emits events when docs update
- Caches docs for performance

### Documentation Generation Flow

**Step 1: File Opened**
```typescript
// User opens file in editor
editorService.onDidActiveEditorChange() fires
  ↓
debouncedProcessActiveFile.schedule() (500ms debounce)
  ↓
processActiveFile() called
```

**Step 2: Get Chunks from Merkle Tree**
```typescript
const fileChunks = await merkleTreeService.getFileChunks(relativePath);
// Returns: [{ startLine, endLine, hash, content? }, ...]
```

**Step 3: Extract Symbols**
```typescript
// Extract symbols for each chunk's range
const symbols = await extractSymbolsForRange(uri, startLine, endLine);
// Uses language server outline model
// Filters symbols within chunk range
```

**Step 4: Create Chunk Records**
```typescript
const chunk: ChunkRecord = {
  uri: uri,
  hash: fileChunk.hash,  // From Merkle tree
  parentHash: fileChunks[i-1]?.hash,  // Sequential link
  description: `Chunk ${i+1} (lines ${startLine+1}-${endLine})`,
  refs: {
    symbols: [...],  // Extracted symbols
    files: [],
    functions: []
  },
  range: new Range(startLine+1, 1, endLine, 1),
  updatedAt: Date.now()
};

await chunkIndexService.upsertChunk(chunk);
```

**Step 5: Generate Documentation**
```typescript
// Generate markdown for each chunk
const content = generateChunkDocContent(chunk);
// Includes: title, file path, hash, parent hash, line range, symbols, functions, etc.

// Store in workspace storage
await storageService.store(`ren.docs.content.${chunkId}`, content);
```

### Change Detection

**When File Changes:**
1. Merkle tree detects change
2. Recomputes chunk hashes
3. Emits `onDidChangeTree` event
4. Docs agent compares old vs new chunk hashes
5. Only regenerates docs for changed chunks (future optimization)
6. Currently: Rebuilds all chunks (to be optimized)

**Example:**
```typescript
// Before: ["abc123...", "def456...", "ghi789..."]
// User edits line 50 (in chunk 1)
// After: ["xyz999...", "def456...", "ghi789..."]
// Only chunk 1 changed!
```

---

## 6. Changelog System (MonitorX)

### What is MonitorX?

**MonitorX** is Ren IDE's AI-powered changelog and workspace monitoring system.

### Features

**1. Changelog Entries**
- Tracks file changes with diffs
- Stores subject and description
- Links to graph references
- Stores metadata (timestamps, authors, etc.)
- Maximum 200 entries (configurable)

**2. Chat Integration**
- AI assistant for workspace questions
- Chat history with search
- Context-aware responses
- Integration with changelog entries

**3. Workspace Store**
- Workspace-scoped storage
- Persists changelog to `monitorx-changelog.json`
- Syncs across machines (if sync enabled)
- Events for changelog changes

### Changelog Entry Structure

```typescript
interface IMonitorXChangelogEntry {
  id: string;                    // UUID
  subject: string;               // Short description
  description: string;           // Detailed description
  timestamp: number;             // Unix timestamp
  files: IMonitorXChangelogFileChange[];  // File changes with diffs
  graph?: IGraphReference;       // Optional graph reference
  metadata?: object;             // Optional metadata
}
```

### Storage

**Location**: Workspace storage (`ren.workspace.monitorx-changelog.json`)

**Key**: `ren.workspace.monitorx-changelog`
**Scope**: Workspace (persists only for current workspace)
**Target**: User (syncs across machines if sync enabled)

---

## 7. All Ren IDE Features

### View Modes

**1. Code View**
- Standard VS Code editor
- Full editing capabilities
- Language support
- Extensions support

**2. Graph View**
- Visualize code dependencies
- Multiple graph modes (file, folder, architecture, data flow, heatmap)
- Interactive node selection
- Zoom and pan
- Node sizing and coloring
- Legend with category filters

**3. MonitorX View**
- AI chat assistant
- Changelog viewer
- Workspace monitoring
- Chat history with search
- Context-aware responses

### Graph View Features

**Modes:**
- **File Graph**: Import dependencies for a single file
- **Folder Graph**: Dependencies for a folder
- **Workspace Graph**: Dependencies for entire workspace
- **Architecture Graph**: Auto-detected application architecture
- **Data Flow Graph**: Function call graphs
- **Git Heatmap**: File co-change patterns from Git history

**Interactions:**
- Click node to open file
- Click edge to jump to import location
- Select mode to highlight node and connections
- Zoom in/out
- Node sizing by imports/exports
- Category filtering
- Legend toggle

### Architecture Detection Features

**Supported Languages:**
- JavaScript/TypeScript (npm, package.json)
- Python (requirements.txt, pyproject.toml)
- Go (go.mod)
- Rust (Cargo.toml)
- Docker Compose (docker-compose.yml)
- GraphQL (.graphql files)
- SQL (database schemas, migrations)

**Detected Components:**
- Applications (React apps, services)
- Frontends (UI components)
- Backends (API services)
- Databases (schemas, tables)
- Caches (Redis, etc.)
- Queues (message queues)
- External Services (APIs)
- Infrastructure (containers, orchestration)

**Detected Relationships:**
- Dependencies (dependsOn)
- Connections (connectsTo)
- Calls (HTTP/RPC)
- Publishes/Consumes (queues)
- Queries (databases)

### Performance Optimizations

**1. Caching**
- Graph cache (LRU, persisted to storage)
- Import descriptor cache (Promise-based)
- Resolved path cache
- Merkle tree cache (10,000 nodes)
- Docs cache

**2. Incremental Updates**
- Only process changed chunks
- Merkle tree tracks changes at chunk level
- Graph cache invalidates only changed nodes
- Docs regenerate only for changed chunks (future)

**3. Debouncing**
- File changes: 500ms debounce
- Merkle tree changes: 1000ms debounce
- Graph updates: Batched
- UI updates: Debounced

**4. Lazy Loading**
- Lazy file tracking (only track actively used files)
- Background tree expansion
- Incremental graph building
- Chunked file processing

### Configuration

**Merkle Tree Settings:**
```json
{
  "merkleTree.enabled": true,
  "merkleTree.lazyTracking": true,
  "merkleTree.excludeStaticDirs": true,
  "merkleTree.cacheSize": 10000,
  "merkleTree.memoryLimitMB": 100,
  "merkleTree.chunkSizeLines": 200,
  "merkleTree.enableChunkedHashing": true
}
```

**Graph Settings:**
- Exclude patterns: `node_modules`, `.git`, `build`, `dist`, etc.
- Supported file extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
- Max depth for data flow graphs: 10 (configurable)
- Architecture detection: Enabled by default

---

## 8. Key Implementation Details

### File Chunking

**Algorithm:**
1. Read file content
2. Split by line breaks
3. Create chunks of 200 lines
4. Hash each chunk (SHA256)
5. Store chunks in Merkle tree

**Benefits:**
- Granular change detection
- Smart cache invalidation
- Incremental updates
- Performance optimization

### Merkle Tree Building

**Process:**
1. Traverse workspace directory
2. Hash each file (chunked or whole-file)
3. Build hierarchical tree structure
4. Calculate directory hashes from children
5. Cache tree nodes
6. Persist to storage

**Incremental Updates:**
1. Detect file system changes
2. Re-hash changed files (only changed chunks)
3. Update affected nodes in tree
4. Propagate hash changes to root
5. Update cache

### Graph Building

**BFS Traversal:**
1. Start with initial files
2. Parse imports from each file
3. Resolve import specifiers
4. Add resolved files to queue
5. Track processed files (avoid cycles)
6. Build nodes and edges
7. Cache results

**Import Resolution:**
1. Expand import candidates (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`)
2. Check index files (`index.ts`, `index.tsx`, etc.)
3. Test each candidate with `fileService.exists()`
4. Return first match
5. Cache resolved paths

### Architecture Detection

**Multi-Language Support:**
- JavaScript/TypeScript: `package.json`, `npm` dependencies
- Python: `requirements.txt`, `pyproject.toml`
- Go: `go.mod` files
- Rust: `Cargo.toml` files
- Docker: `docker-compose.yml`
- Database: SQL files, migrations
- GraphQL: `.graphql` files

**Detection Methods:**
- File pattern matching
- Dependency analysis
- Symbol extraction
- Code pattern matching (regex)
- Language server symbols
- Confidence scoring

### Documentation Generation

**Flow:**
1. File opened in editor
2. Get chunks from Merkle tree
3. Extract symbols for each chunk
4. Create chunk records with metadata
5. Generate markdown documentation
6. Store in workspace storage
7. Emit update events

**Change Detection:**
1. Merkle tree detects file change
2. Recomputes chunk hashes
3. Compares old vs new hashes
4. Identifies changed chunks
5. Regenerates docs for changed chunks (future)

---

## 9. Demo Script (3 Minutes)

### Introduction (30 seconds)
- "Ren IDE is a powerful code intelligence platform built on VS Code"
- "It provides advanced features for understanding code structure, dependencies, and architecture"
- "Let me show you the key features"

### Merkle Tree & Chunking (45 seconds)
- "Ren IDE uses a Merkle tree to track code changes at a granular level"
- "Files are divided into 200-line chunks, each independently hashed"
- "Chunks are connected sequentially - each chunk points to the previous chunk's hash"
- "This creates a linked list structure that enables efficient traversal and change detection"
- "This enables efficient change detection and smart caching"
- "Only changed chunks are processed, not entire files"
- **Demo**: Show chunk hashes in docs view, explain sequential connections, demonstrate change detection

### Graph View (60 seconds)
- "The Graph View visualizes code dependencies and architecture"
- "You can view import graphs for files, folders, or entire workspaces"
- "Architecture mode automatically detects applications, databases, and services"
- "Data flow mode shows function call graphs"
- "Git heatmap shows which files change together"
- **Demo**: Switch between graph modes, show architecture detection, demonstrate node selection

### Documentation System (30 seconds)
- "Ren IDE automatically generates documentation from code chunks"
- "Each chunk is documented with symbols, functions, and references"
- "Documentation updates automatically when code changes"
- **Demo**: Show docs view, explain chunk-based documentation

### MonitorX & Changelog (15 seconds)
- "MonitorX provides AI-powered workspace monitoring and changelog tracking"
- "Track file changes with diffs and metadata"
- **Demo**: Show MonitorX view, explain changelog entries

### Conclusion (15 seconds)
- "Ren IDE combines advanced code intelligence with efficient change tracking"
- "The Merkle tree system enables granular change detection"
- "Graph views help you understand code structure and architecture"
- "Documentation is automatically generated and kept up to date"

---

## 10. Key Talking Points

### Merkle Tree
- "Files are divided into 200-line chunks"
- "Each chunk is independently hashed using SHA256"
- "Only changed chunks are recalculated"
- "Smart caching reduces processing time"
- "Workspace state is represented by a single root hash"

### Graph Generation
- "Graphs are built using breadth-first search"
- "Import resolution handles multiple file extensions"
- "Circular dependencies are detected and handled"
- "Architecture detection supports multiple languages"
- "Git heatmap shows file co-change patterns"

### Documentation
- "Documentation is generated from code chunks"
- "Each chunk is documented with symbols and references"
- "Documentation updates automatically when code changes"
- "Chunk-based approach enables incremental updates"

### Performance
- "Multiple levels of caching reduce processing time"
- "Incremental updates process only changed chunks"
- "Debouncing batches rapid changes"
- "Lazy loading tracks only actively used files"

---

## 11. Technical Specifications

### Chunking
- **Default chunk size**: 200 lines
- **Hash algorithm**: SHA256
- **Chunk storage**: Merkle tree nodes
- **Change detection**: Hash comparison

### Merkle Tree
- **Cache size**: 10,000 nodes (configurable)
- **Memory limit**: 100 MB (configurable)
- **Persistence**: Every 30 seconds
- **Garbage collection**: 5 minutes
- **Debounce**: 100ms

### Graph Building
- **Supported languages**: TypeScript, JavaScript, Python, Go, Rust
- **Import resolution**: Multiple file extensions
- **Max depth**: 10 levels (configurable)
- **Cache**: LRU, persisted to storage

### Architecture Detection
- **Supported ecosystems**: Node, Python, Go, Rust, Docker
- **Component types**: 13 types (application, frontend, backend, etc.)
- **Relationship types**: 7 types (dependsOn, connectsTo, calls, etc.)
- **Confidence scoring**: Based on evidence strength

### Documentation
- **Format**: Markdown
- **Storage**: Workspace storage
- **Update frequency**: On file change
- **Chunk metadata**: Symbols, functions, references

---

## 12. File Locations Reference

### Core Files
- **Product config**: `product.json`
- **Merkle tree**: `src/vs/platform/merkleTree/`
- **Graph view**: `src/vs/workbench/contrib/renViews/browser/views/graphView/`
- **Architecture analyzer**: `src/vs/workbench/contrib/renViews/browser/views/graphView/architectureAnalyzer.ts`
- **Graph data builder**: `src/vs/workbench/contrib/renViews/browser/views/graphView/graphDataBuilder.ts`
- **Docs service**: `src/vs/workbench/contrib/renViews/browser/services/docsService.ts`
- **MonitorX view**: `src/vs/workbench/contrib/renViews/browser/views/monitorXView.ts`
- **Workspace store**: `src/vs/workbench/contrib/renViews/browser/renWorkspaceStore.ts`

### Documentation
- **Merkle tree README**: `src/vs/platform/merkleTree/README.md`
- **Docs integration guide**: `src/vs/workbench/contrib/renViews/browser/DOCS_MERKLE_INTEGRATION_GUIDE.md`
- **Complex parts explained**: `COMPLEX_PARTS_EXPLAINED.md`

---

## Summary

Ren IDE is a powerful code intelligence platform that combines:
1. **Merkle Tree System**: Granular change tracking with chunk-level hashing
2. **Graph View**: Visualize code dependencies and architecture
3. **Documentation System**: Automatic documentation generation from chunks
4. **MonitorX**: AI-powered workspace monitoring and changelog tracking
5. **Performance Optimizations**: Caching, incremental updates, lazy loading

The system is designed for efficiency, with smart caching, incremental updates, and granular change detection enabling fast processing of large codebases.

