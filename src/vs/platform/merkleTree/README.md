# Chunked Merkle Tree System

## Overview

The Chunked Merkle Tree System provides a hierarchical, cryptographic hash-based representation of the workspace file system. Files are divided into 200-line chunks (configurable), with each chunk independently hashed. This enables granular change detection, smart caching, and efficient incremental updates.

### Key Features

- **Chunked File Hashing**: Files are split into 200-line chunks, each independently hashed
- **Incremental Updates**: Only changed chunks are recalculated when files are modified
- **Smart Caching**: Enables intelligent cache invalidation based on chunk-level changes
- **Lazy Tracking**: Optionally track only actively used files to reduce initial overhead
- **Large Repository Support**: Optimized strategies for small, medium, large, and massive repositories
- **Automatic Change Tracking**: Monitors file system changes and updates the tree automatically

## Architecture

### Core Components

1. **MerkleTreeService** - Main service interface for accessing Merkle tree functionality
2. **MerkleTreeBuilder** - Builds and maintains the Merkle tree structure
3. **MerkleTreeCache** - LRU cache with persistence for tree nodes and snapshots
4. **MerkleTreeChangeTracker** - Monitors file system and editor changes

### Data Flow

```
File System Changes
    ↓
MerkleTreeChangeTracker (detects changes)
    ↓
MerkleTreeBuilder (updates tree)
    ↓
MerkleTreeCache (caches results)
    ↓
MerkleTreeService (exposes API)
```

## API Reference

### IMerkleTreeService

The main service interface for interacting with the Merkle tree.

#### Properties

```typescript
readonly rootHash: string;
```
The SHA256 hash of the root node, representing the entire workspace state.

```typescript
readonly onDidChangeTree: Event<{ oldHash: string; newHash: string }>;
```
Event emitted when the tree changes. Provides old and new root hashes.

#### Methods

##### `getTree(): Promise<MerkleTreeNode>`
Returns the complete tree structure.

**Returns:** Promise resolving to the root node of the Merkle tree.

**Example:**
```typescript
const tree = await merkleTreeService.getTree();
console.log(`Root hash: ${tree.hash}`);
console.log(`Total files: ${countFiles(tree)}`);
```

##### `getSubtreeHash(uri: URI): Promise<string | undefined>`
Gets the hash of a subtree (directory and all its contents).

**Parameters:**
- `uri: URI` - The URI of the directory

**Returns:** Promise resolving to the subtree hash, or `undefined` if not found.

**Example:**
```typescript
const dirUri = URI.file('/path/to/directory');
const hash = await merkleTreeService.getSubtreeHash(dirUri);
if (hash) {
  console.log(`Directory hash: ${hash}`);
}
```

##### `getPathHash(relativePath: string): Promise<string | undefined>`
Gets the hash of a specific file path.

**Parameters:**
- `relativePath: string` - Relative path from workspace root

**Returns:** Promise resolving to the file hash, or `undefined` if not found.

**Example:**
```typescript
const hash = await merkleTreeService.getPathHash('src/utils.ts');
```

##### `getFileChunks(relativePath: string): Promise<FileChunk[] | undefined>`
Gets all chunks for a specific file.

**Parameters:**
- `relativePath: string` - Relative path from workspace root

**Returns:** Promise resolving to array of file chunks, or `undefined` if not found.

**Example:**
```typescript
const chunks = await merkleTreeService.getFileChunks('src/file.ts');
if (chunks) {
  chunks.forEach((chunk, index) => {
    console.log(`Chunk ${index}: lines ${chunk.startLine}-${chunk.endLine}, hash: ${chunk.hash}`);
  });
}
```

##### `getChangedChunks(relativePath: string, oldChunks?: FileChunk[]): Promise<{ changed: number[]; unchanged: number[] }>`
Compares chunks between two versions of a file and returns which chunks changed.

**Parameters:**
- `relativePath: string` - Relative path from workspace root
- `oldChunks?: FileChunk[]` - Optional previous chunk state for comparison

**Returns:** Promise resolving to an object with:
- `changed: number[]` - Array of chunk indices that changed
- `unchanged: number[]` - Array of chunk indices that didn't change

**Example:**
```typescript
const oldChunks = await getPreviousChunks(); // Get from cache/snapshot
const { changed, unchanged } = await merkleTreeService.getChangedChunks(
  'src/file.ts',
  oldChunks
);

console.log(`Changed chunks: [${changed.join(', ')}]`);
console.log(`Unchanged chunks: [${unchanged.join(', ')}]`);

// Only process changed chunks
for (const chunkIndex of changed) {
  await processChunk(chunkIndex);
}
```

##### `getChangeLog(since?: number): MerkleTreeChange[]`
Gets the change log since a specific timestamp.

**Parameters:**
- `since?: number` - Optional timestamp (milliseconds). If omitted, returns all changes.

**Returns:** Array of change records.

**Example:**
```typescript
// Get all changes
const allChanges = merkleTreeService.getChangeLog();

// Get changes in last hour
const oneHourAgo = Date.now() - 60 * 60 * 1000;
const recentChanges = merkleTreeService.getChangeLog(oneHourAgo);

recentChanges.forEach(change => {
  console.log(`${change.type}: ${change.path} at ${new Date(change.timestamp)}`);
});
```

##### `getSnapshot(version?: number): Promise<MerkleTreeSnapshot>`
Gets a snapshot of the tree at a specific version.

**Parameters:**
- `version?: number` - Optional version number. If omitted, returns the latest snapshot.

**Returns:** Promise resolving to a tree snapshot.

**Example:**
```typescript
// Get latest snapshot
const latest = await merkleTreeService.getSnapshot();

// Get specific version
const v5 = await merkleTreeService.getSnapshot(5);

console.log(`Snapshot version: ${v5.version}`);
console.log(`Timestamp: ${new Date(v5.timestamp)}`);
console.log(`Root hash: ${v5.rootHash}`);
```

##### `forceRebuild(): Promise<void>`
Forces a complete rebuild of the tree.

**Example:**
```typescript
await merkleTreeService.forceRebuild();
console.log('Tree rebuilt');
```

##### `invalidatePath(uri: URI): Promise<void>`
Marks a specific path as dirty for recalculation.

**Parameters:**
- `uri: URI` - The URI to invalidate

**Example:**
```typescript
const fileUri = URI.file('/path/to/file.ts');
await merkleTreeService.invalidatePath(fileUri);
```

##### `ensureTracked(uri: URI): Promise<void>`
Ensures a file is tracked (for lazy tracking mode).

**Parameters:**
- `uri: URI` - The URI to track

**Example:**
```typescript
const fileUri = URI.file('/path/to/file.ts');
await merkleTreeService.ensureTracked(fileUri);
```

##### `getRepoSizeCategory(): "small" | "medium" | "large" | "massive"`
Gets the repository size category based on file count.

**Returns:** Category string.

**Example:**
```typescript
const category = merkleTreeService.getRepoSizeCategory();
console.log(`Repository size: ${category}`);
```

## Type Definitions

### MerkleTreeNode

```typescript
interface MerkleTreeNode {
  hash: string;                    // SHA256 hash of this node
  path: string;                    // Relative path from workspace root
  type: 'file' | 'directory';      // Node type
  children?: MerkleTreeNode[];      // For directories
  fileHash?: string;               // Content hash for files (full file hash)
  chunks?: FileChunk[];            // Chunk hashes for files (200-line chunks)
  size?: number;                    // File size in bytes
  mtime?: number;                   // Modification time
  isTracked?: boolean;             // Whether this file is actively tracked (lazy tracking)
}
```

### FileChunk

```typescript
interface FileChunk {
  startLine: number;              // Starting line number (0-based)
  endLine: number;                // Ending line number (exclusive)
  hash: string;                    // SHA256 hash of this chunk
  content?: string;                // Optional: cached content (for small chunks < 10KB)
}
```

### MerkleTreeSnapshot

```typescript
interface MerkleTreeSnapshot {
  rootHash: string;                // Root hash at snapshot time
  timestamp: number;               // When snapshot was taken (milliseconds)
  version: number;                 // Snapshot version number
  tree: MerkleTreeNode;            // Complete tree structure
  changeLog: MerkleTreeChange[];  // Change log entries
}
```

### MerkleTreeChange

```typescript
interface MerkleTreeChange {
  type: 'added' | 'deleted' | 'modified';
  path: string;                    // File path
  oldHash?: string;                // Previous hash (for modified files)
  newHash?: string;                // New hash (for modified/added files)
  timestamp: number;               // When change occurred (milliseconds)
}
```

## Configuration

### Configuration Options

The Merkle tree service can be configured via VS Code settings:

```json
{
  "merkleTree": {
    "enabled": true,                    // Enable/disable the service
    "lazyTracking": true,                // Only track actively used files
    "excludeStaticDirs": true,           // Exclude node_modules, .git, etc.
    "cacheSize": 10000,                  // LRU cache size
    "memoryLimitMB": 100,                // Memory limit in MB
    "strategy": "auto",                  // "auto" | "full" | "sparse" | "ultra-sparse"
    "chunkSizeLines": 200,               // Lines per chunk (default: 200)
    "enableChunkedHashing": true         // Enable chunked hashing (default: true)
  }
}
```

### Configuration Constants

#### Repository Size Thresholds

```typescript
REPO_SIZE_THRESHOLDS = {
  SMALL: 10_000,      // < 10k files: full tree
  MEDIUM: 50_000,     // 10k-50k: sparse tree
  LARGE: 500_000,     // 50k-500k: directory-level hashing
  MASSIVE: 500_000,   // > 500k: ultra-sparse
}
```

#### Cache Size Limits

```typescript
CACHE_SIZE_LIMITS = {
  SMALL: 10_000,
  MEDIUM: 50_000,
  LARGE: 100_000,
}
```

#### Memory Limits

```typescript
MEMORY_LIMITS = {
  DEFAULT: 100,        // Small repos
  MEDIUM: 500,         // Medium repos
  LARGE: 1000,         // Large repos
}
```

#### Default Configuration

```typescript
DEFAULT_CONFIG = {
  enabled: true,
  lazyTracking: true,
  excludeStaticDirs: true,
  cacheSize: 10_000,
  memoryLimitMB: 100,
  autoRebuild: true,
  changeLogSize: 1000,
  strategy: 'auto',
  workerThreads: Math.max(1, navigator.hardwareConcurrency - 1),
  backgroundExpansion: true,
  debounceMs: 100,
  gcIntervalMs: 5 * 60 * 1000,        // 5 minutes
  persistIntervalMs: 30 * 1000,        // 30 seconds
  chunkSizeLines: 200,
  enableChunkedHashing: true,
}
```

## Implementation Details

### Chunked Hashing Algorithm

1. **File Reading**: Read entire file content
2. **Line Splitting**: Split content by line breaks (`\r?\n`)
3. **Chunk Creation**: Create chunks of `chunkSizeLines` (default: 200)
4. **Chunk Hashing**: Hash each chunk independently using SHA256
5. **File Hash**: Combine all chunk hashes into a single file hash

```typescript
// Pseudocode
function hashFileChunked(fileContent: string): { chunks: FileChunk[], fileHash: string } {
  const lines = fileContent.split(/\r?\n/);
  const chunks: FileChunk[] = [];
  
  for (let startLine = 0; startLine < lines.length; startLine += CHUNK_SIZE) {
    const endLine = Math.min(startLine + CHUNK_SIZE, lines.length);
    const chunkContent = lines.slice(startLine, endLine).join('\n');
    const chunkHash = sha256(chunkContent);
    
    chunks.push({
      startLine,
      endLine,
      hash: chunkHash,
      content: chunkContent.length < 10000 ? chunkContent : undefined
    });
  }
  
  const fileHash = sha256(chunks.map(c => `${c.startLine}-${c.endLine}:${c.hash}`).join('|'));
  return { chunks, fileHash };
}
```

### Tree Building

#### Initial Build

1. **Strategy Selection**: Determine strategy based on repository size
2. **Directory Traversal**: Recursively scan workspace
3. **File Processing**: Hash each file (chunked or whole-file)
4. **Tree Construction**: Build hierarchical tree structure
5. **Hash Calculation**: Calculate directory hashes from children

#### Incremental Updates

1. **Change Detection**: Monitor file system events
2. **File Hashing**: Re-hash changed files (only changed chunks if chunked)
3. **Tree Update**: Update affected nodes in tree
4. **Hash Propagation**: Update parent directory hashes up to root
5. **Cache Update**: Update cache with new hashes

### Caching Strategy

#### LRU Cache

- **Node Cache**: Stores tree nodes by path
- **Subtree Cache**: Stores subtree hashes by path
- **Eviction**: Least recently used nodes evicted when cache is full
- **Garbage Collection**: Unused nodes evicted after 5 minutes

#### Persistence

- **Storage**: Persisted to VS Code workspace storage
- **Frequency**: Saved every 30 seconds
- **Format**: JSON serialization of tree structure
- **Recovery**: Loaded on service initialization

### Change Tracking

#### File System Events

- **Added**: New files detected
- **Deleted**: File deletions detected
- **Modified**: File modifications detected

#### Editor Events

- **Open Files**: Track files currently open in editors
- **Undo/Redo**: Detect editor undo/redo operations

#### Debouncing

- **Update Delay**: 100ms debounce to batch rapid changes
- **Batch Processing**: Process multiple changes together

## Usage Examples

### Basic Usage

```typescript
// Get service instance
const merkleTreeService = accessor.get(IMerkleTreeService);

// Get current root hash
const rootHash = merkleTreeService.rootHash;
console.log(`Workspace state: ${rootHash}`);

// Listen for changes
merkleTreeService.onDidChangeTree(({ oldHash, newHash }) => {
  console.log(`Tree changed: ${oldHash} → ${newHash}`);
});
```

### Smart Cache Invalidation

```typescript
// Example: Graph View uses chunk hashes to skip re-parsing
const fileUri = URI.file('/path/to/file.ts');
const relativePath = getRelativePath(fileUri);
const currentChunks = await merkleTreeService.getFileChunks(relativePath);

if (currentChunks) {
  const cachedChunks = getCachedChunks(relativePath);
  
  if (cachedChunks && chunksEqual(currentChunks, cachedChunks)) {
    // All chunks unchanged - use cached parse result
    return getCachedImports(relativePath);
  } else {
    // Some chunks changed - re-parse
    const imports = await parseImports(fileUri);
    cacheImports(relativePath, imports, currentChunks);
    return imports;
  }
}
```

### Incremental Processing

```typescript
// Process only changed chunks
const { changed, unchanged } = await merkleTreeService.getChangedChunks(
  'src/file.ts',
  oldChunks
);

// Process unchanged chunks from cache
for (const chunkIndex of unchanged) {
  const cachedResult = getCachedChunkResult(chunkIndex);
  useCachedResult(cachedResult);
}

// Process only changed chunks
for (const chunkIndex of changed) {
  const chunk = currentChunks[chunkIndex];
  const result = await processChunk(chunk);
  cacheChunkResult(chunkIndex, result);
}
```

### Change Monitoring

```typescript
// Monitor all changes
merkleTreeService.onDidChangeTree(({ oldHash, newHash }) => {
  const changes = merkleTreeService.getChangeLog(Date.now() - 1000);
  
  changes.forEach(change => {
    console.log(`${change.type}: ${change.path}`);
  });
});

// Get changes in last hour
const oneHourAgo = Date.now() - 60 * 60 * 1000;
const recentChanges = merkleTreeService.getChangeLog(oneHourAgo);

const modifiedFiles = recentChanges
  .filter(c => c.type === 'modified')
  .map(c => c.path);
```

### Snapshot Comparison

```typescript
// Create snapshot before major operation
const beforeSnapshot = await merkleTreeService.getSnapshot();

// Perform operation
await performMajorRefactor();

// Get snapshot after
const afterSnapshot = await merkleTreeService.getSnapshot();

// Compare
if (beforeSnapshot.rootHash !== afterSnapshot.rootHash) {
  console.log('Workspace changed during operation');
  const changes = afterSnapshot.changeLog.filter(
    c => c.timestamp >= beforeSnapshot.timestamp
  );
  console.log(`${changes.length} files changed`);
}
```

## Integration Examples

### Graph View Integration

The Graph View uses chunked hashing for smart cache invalidation:

```typescript
// In GraphDataBuilder
const currentChunks = await this.merkleTreeService.getFileChunks(relativePath);
const cachedData = parsedChunkCache.get(fileKey);

if (cachedData && chunksUnchanged(cachedData.chunks, currentChunks)) {
  // Skip parsing - use cached result
  return cachedData.descriptors;
} else {
  // Parse and cache
  const descriptors = await parseImports(fileUri);
  parsedChunkCache.set(fileKey, { chunks: currentChunks, descriptors });
  return descriptors;
}
```

## Performance Considerations

### Memory Usage

- **Chunk Storage**: Each chunk stores ~64 bytes (hash) + optional content
- **Tree Nodes**: ~200 bytes per node
- **Cache Limits**: Configurable based on repository size
- **Garbage Collection**: Automatic eviction of unused nodes

### CPU Usage

- **Hashing**: SHA256 is fast but can be CPU-intensive for large files
- **Chunking**: Line splitting is O(n) where n is file size
- **Tree Updates**: O(log n) for directory updates, O(1) for file updates
- **Debouncing**: Reduces update frequency for rapid changes

### Storage

- **Persistence**: Tree structure persisted to workspace storage
- **Size**: Approximately 1KB per 100 files (with chunking)
- **Frequency**: Saved every 30 seconds to disk

## Best Practices

1. **Lazy Tracking**: Enable for large repositories to reduce initial overhead
2. **Static Directory Exclusion**: Always exclude `node_modules`, `.git`, etc.
3. **Chunk Size**: 200 lines is optimal for most use cases
4. **Cache Size**: Adjust based on repository size (10k-100k nodes)
5. **Change Monitoring**: Use debounced change events for efficient updates

## Troubleshooting

### Tree Not Building

- Check if service is enabled: `merkleTree.enabled`
- Verify workspace is open
- Check logs for errors

### High Memory Usage

- Reduce cache size
- Enable lazy tracking
- Increase garbage collection frequency

### Slow Updates

- Check if chunked hashing is enabled
- Verify exclude patterns are correct
- Consider increasing debounce time

## Future Enhancements

- **Incremental Parsing**: Only parse changed chunks
- **Content-Defined Chunking**: Variable chunk sizes based on content
- **Parallel Hashing**: Multi-threaded chunk hashing
- **Change Visualization**: UI showing which chunks changed
- **AI Integration**: Send only changed chunks to AI agents

