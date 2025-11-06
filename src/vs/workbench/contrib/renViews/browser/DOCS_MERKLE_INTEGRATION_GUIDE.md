# Docs System & Merkle Tree Integration - Detailed Guide

## Overview

The docs system uses the Merkle tree to:

1. **Detect file changes** at chunk granularity
2. **Track which chunks changed** (not just "file changed")
3. **Only regenerate docs for changed chunks** (performance optimization)
4. **Maintain chunk metadata** (hashes, ranges, symbols) synchronized with Merkle tree

---

## Architecture: Three-Layer System

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Merkle Tree Service (Source of Truth)        │
│  - Tracks file system changes                          │
│  - Chunks files into 200-line pieces                    │
│  - Computes SHA256 hashes for each chunk                │
│  - Emits events when tree changes                      │
└─────────────────────────────────────────────────────────┘
                        ↓ (provides chunks)
┌─────────────────────────────────────────────────────────┐
│  Layer 2: Chunk Index Service (Metadata Layer)          │
│  - Stores chunk records with metadata                   │
│  - Tracks parentHash (sequential), children (hierarchical)│
│  - Extracts symbols from each chunk                    │
│  - Maps files → chunks                                  │
└─────────────────────────────────────────────────────────┘
                        ↓ (provides enriched chunks)
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Docs Service (Documentation Generation)      │
│  - Generates markdown docs for chunks                   │
│  - Stores generated docs in workspace storage           │
│  - Emits events when docs update                       │
│  - Caches docs for performance                         │
└─────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Flow

### Phase 1: Initialization (When File is First Opened)

#### Step 1.1: User Opens File

```typescript
// Location: docsAgent.contribution.ts:53-67
User opens file.ts in editor
    ↓
editorService.onDidActiveEditorChange() fires
    ↓
debouncedProcessActiveFile.schedule() (500ms debounce)
    ↓
processActiveFile() called
```

#### Step 1.2: Check Existing Chunks

```typescript
// Location: docsAgent.contribution.ts:78-86
ensureChunksForFile(uri) called
    ↓
Check if chunks already exist in ChunkIndexService
    ↓
If YES: Just regenerate docs (chunks already indexed)
If NO: Continue to build from Merkle tree
```

#### Step 1.3: Get Chunks from Merkle Tree

```typescript
// Location: docsAgent.contribution.ts:88-94
const relativePath = getRelativePath(uri)  // "src/file.ts"
    ↓
const fileChunks = await merkleTreeService.getFileChunks(relativePath)
```

**What happens inside MerkleTreeService:**

```typescript
// Location: merkleTreeService.ts:466-479
async getFileChunks(relativePath: string) {
    1. Ensure Merkle tree is initialized
    2. Get tree from cache
    3. Find file node by path
    4. Return node.chunks (FileChunk[])
}
```

**What FileChunk looks like:**

```typescript
interface FileChunk {
	startLine: number; // 0, 200, 400, 600... (0-based)
	endLine: number; // 200, 400, 600, 800... (exclusive)
	hash: string; // SHA256 hash of chunk content
	content?: string; // Optional: cached content (< 10KB)
}
```

**Example for a 600-line file:**

```javascript
[
	{ startLine: 0, endLine: 200, hash: "abc123..." },
	{ startLine: 200, endLine: 400, hash: "def456..." },
	{ startLine: 400, endLine: 600, hash: "ghi789..." },
];
```

#### Step 1.4: Extract Symbols for Each Chunk

```typescript
// Location: docsAgent.contribution.ts:105-128
for (let i = 0; i < fileChunks.length; i++) {
    const fileChunk = fileChunks[i];

    // Extract symbols in this chunk's range
    const symbols = await extractSymbolsForRange(
        uri,
        fileChunk.startLine,  // 0, 200, 400...
        fileChunk.endLine     // 200, 400, 600...
    );

    // Create ChunkRecord with metadata
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

    // Store in ChunkIndexService
    await chunkIndexService.upsertChunk(chunk);
}
```

**Symbol Extraction Details:**

```typescript
// Location: docsAgent.contribution.ts:197-223
extractSymbolsForRange(uri, startLine, endLine) {
    1. Get text model reference for the file
    2. Get outline model (symbol tree) from OutlineModelService
    3. Get top-level symbols (classes, functions, etc.)
    4. Filter symbols that fall within chunk range
    5. Return SymbolRef[] with name, kind, uri, range
}
```

**Example symbols extracted:**

```typescript
// Chunk 1 (lines 0-199) might have:
[
  { name: "MyClass", kind: "Class", uri: ..., range: Range(10, 1, 50, 1) },
  { name: "myFunction", kind: "Function", uri: ..., range: Range(60, 1, 80, 1) }
]

// Chunk 2 (lines 200-399) might have:
[
  { name: "anotherFunction", kind: "Function", uri: ..., range: Range(250, 1, 270, 1) }
]
```

#### Step 1.5: Store Chunk Hashes for Change Detection

```typescript
// Location: docsAgent.contribution.ts:131
this.lastKnownChunks.set(fileUri, chunkHashes);
// Stores: ["abc123...", "def456...", "ghi789..."]
// This is used later to detect which chunks changed
```

#### Step 1.6: Generate Initial Documentation

```typescript
// Location: docsAgent.contribution.ts:134
await docsService.generateDocsForFile(uri, "initialize");
```

**What happens in DocsService:**

```typescript
// Location: docsServiceImpl.ts:106-130
async generateDocsForFile(uri, mode) {
    1. Get all chunks for file from ChunkIndexService
    2. For each chunk:
       a. Generate markdown content (generateChunkDocContent)
       b. Create ChunkDocs object
       c. Store in cache (chunkDocsCache)
       d. Store in workspace storage
       e. Fire onDidUpdateChunkDocs event
    3. Return array of ChunkDocs
}
```

**Doc Generation:**

```typescript
// Location: docsServiceImpl.ts:46-90
generateChunkDocContent(chunk) {
    // Build markdown from chunk metadata:
    - Title: chunk.description
    - File path
    - Hash (first 16 chars)
    - Parent hash (if exists)
    - Line range
    - Referenced symbols list
    - Functions list
    - Referenced files list
    - Generation timestamp
}
```

---

### Phase 2: Change Detection (When File is Modified)

#### Step 2.1: File System Change Detected

```typescript
// Location: merkleTreeChangeTracker.ts
File saved or modified
    ↓
FileService.onDidFilesChange() fires
    ↓
MerkleTreeChangeTracker processes change
    ↓
MerkleTreeBuilder.updateFile() called
```

#### Step 2.2: Merkle Tree Recomputes Chunks

```typescript
// Location: merkleTreeBuilder.ts:255-308
hashFileChunked(uri) {
    1. Read file content
    2. Split into lines
    3. Create chunks of 200 lines each
    4. Hash each chunk: SHA256(chunkContent)
    5. Store chunks in cache
    6. Compute file hash from all chunk hashes
    7. Return { chunks, fileHash }
}
```

**Key Point:** Each chunk is independently hashed. If line 50 changes:

- Chunk 1 (0-199) hash changes
- Chunk 2 (200-399) hash stays same
- Chunk 3 (400-599) hash stays same

#### Step 2.3: Merkle Tree Emits Change Event

```typescript
// Location: merkleTreeService.ts:325-331
if (rootHash changed) {
    emitTreeChange(oldHash, newHash, changes)
        ↓
    onDidChangeTree event fires
}
```

#### Step 2.4: Docs Agent Reacts to Merkle Change

```typescript
// Location: docsAgent.contribution.ts:44-47
merkleTreeService.onDidChangeTree(() => {
	debouncedProcessMerkleChange.schedule(); // 1000ms debounce
});
```

#### Step 2.5: Compare Old vs New Chunk Hashes

```typescript
// Location: docsAgent.contribution.ts:159-195
handleMerkleChangeForFile(uri) {
    // Get current chunks from Merkle tree
    const currentChunks = await merkleTreeService.getFileChunks(relativePath);
    const newHashes = currentChunks.map(c => c.hash);

    // Get old hashes we stored earlier
    const oldHashes = this.lastKnownChunks.get(fileUri) || [];

    // Compare hashes by index
    const changedHashes = [];
    for (let i = 0; i < currentChunks.length; i++) {
        if (oldHashes[i] !== newHashes[i]) {
            changedHashes.push(newHashes[i]);  // This chunk changed!
        }
    }
}
```

**Example:**

```javascript
// Before file change:
oldHashes = ["abc123...", "def456...", "ghi789..."];

// User edits line 50 in file
// Merkle tree recomputes:
newHashes = ["xyz999...", "def456...", "ghi789..."];
//                    ↑
//              Chunk 1 changed!

changedHashes = ["xyz999..."];
```

#### Step 2.6: Update Chunk Index (Current: Full Rebuild)

```typescript
// Location: docsAgent.contribution.ts:185-188
// CURRENT IMPLEMENTATION (inefficient):
if (changedHashes.length > 0) {
	await chunkIndexService.removeChunksForFile(uri); // Remove ALL
	await ensureChunksForFile(uri); // Rebuild ALL
}
```

**What happens:**

1. Remove all chunks from index
2. Re-extract all chunks from Merkle tree
3. Re-extract all symbols for all chunks
4. Re-store all chunks
5. Regenerate docs for ALL chunks

**Problem:** Even if only 1 chunk changed, we rebuild all chunks.

#### Step 2.7: Regenerate Docs for Changed Chunks

```typescript
// Location: docsServiceImpl.ts:169-194
async refreshChangedChunks(uri, changedChunkHashes) {
    const chunks = await chunkIndexService.getChunksForFile(uri);

    for (const chunk of chunks) {
        if (changedChunkHashes.includes(chunk.hash)) {
            // Only regenerate docs for changed chunks!
            const content = await generateChunkDocContent(chunk);
            // Store and fire event
        }
    }
}
```

---

## Data Flow Diagram

```
┌──────────────┐
│ File Changes │
└──────┬───────┘
       │
       ▼
┌─────────────────────────┐
│ MerkleTreeChangeTracker │
│ - Detects file changes   │
│ - Debounces (avoid spam) │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│ MerkleTreeBuilder       │
│ - Reads file content    │
│ - Splits into chunks    │
│ - Hashes each chunk     │
│ - Updates tree cache    │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│ MerkleTreeService       │
│ - Stores chunks in tree │
│ - Emits onDidChangeTree │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│ DocsAgent               │
│ - Listens to tree event  │
│ - Gets file chunks      │
│ - Compares old vs new   │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│ ChunkIndexService        │
│ - Stores chunk metadata │
│ - Extracts symbols      │
│ - Tracks parentHash      │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│ DocsService             │
│ - Generates markdown    │
│ - Stores in workspace  │
│ - Emits update events   │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│ DocsViewPane            │
│ - Displays chunks       │
│ - Shows doc preview     │
│ - Updates on changes    │
└─────────────────────────┘
```

---

## Key Data Structures

### 1. Merkle Tree FileChunk (Source of Truth)

```typescript
interface FileChunk {
	startLine: number; // 0-based line number
	endLine: number; // Exclusive end line
	hash: string; // SHA256 hash of chunk content
	content?: string; // Optional cached content
}
```

### 2. ChunkIndex ChunkRecord (Enriched Metadata)

```typescript
interface ChunkRecord {
	uri: URI; // File URI
	hash: string; // From Merkle FileChunk.hash
	parentHash?: string; // Previous chunk's hash (sequential)
	children?: string[]; // Child chunk hashes (hierarchical)
	description?: string; // Human-readable description
	refs: {
		symbols: SymbolRef[]; // Symbols in this chunk
		files: URI[]; // Referenced files
		functions: FunctionPointer[];
	};
	range?: IRange; // Line range (1-based)
	updatedAt: number; // Timestamp
}
```

### 3. DocsService ChunkDocs (Generated Output)

```typescript
interface ChunkDocs {
	chunkId: string; // "file://path#hash"
	content: string; // Markdown documentation
	format: "markdown";
	generatedAt: number; // Timestamp
}
```

---

## Storage Schema

### ChunkIndexService Storage

```typescript
// Key: "ren.docs.chunkIndex"
// Value: JSON object
{
  "file://path/to/file.ts#abc123": {
    uri: "file://path/to/file.ts",
    hash: "abc123...",
    parentHash: undefined,
    children: [],
    description: "Chunk 1 (lines 1-200)",
    refs: { symbols: [...], files: [], functions: [] },
    range: { startLineNumber: 1, endLineNumber: 200, ... },
    updatedAt: 1234567890
  },
  "file://path/to/file.ts#def456": { ... }
}

// Key: "ren.docs.fileToChunks"
// Value: JSON object
{
  "file://path/to/file.ts": [
    "file://path/to/file.ts#abc123",
    "file://path/to/file.ts#def456",
    "file://path/to/file.ts#ghi789"
  ]
}
```

### DocsService Storage

```typescript
// Key: "ren.docs.content.file://path/to/file.ts#abc123"
// Value: JSON string
{
  chunkId: "file://path/to/file.ts#abc123",
  content: "# Chunk 1\n\n**File:** `file.ts`\n...",
  format: "markdown",
  generatedAt: 1234567890
}
```

---

## Event Flow

### 1. File Change → Merkle Tree

```
FileSystemChange
    ↓
MerkleTreeChangeTracker.onDidFilesChange
    ↓
MerkleTreeBuilder.updateFile
    ↓
MerkleTreeService.onDidChangeTree.fire({ oldHash, newHash })
```

### 2. Merkle Tree → Docs Agent

```
MerkleTreeService.onDidChangeTree
    ↓
DocsAgent.processMerkleChange (debounced 1000ms)
    ↓
DocsAgent.handleMerkleChangeForFile
    ↓
Compare oldHashes vs newHashes
    ↓
Update ChunkIndexService
    ↓
DocsService.refreshChangedChunks
```

### 3. Docs Service → UI

```
DocsService.refreshChangedChunks
    ↓
DocsService._onDidUpdateChunkDocs.fire(chunkDoc)
    ↓
DocsViewPane.onDidUpdateChunkDocs listener
    ↓
DocsViewPane.updateForActiveFile
    ↓
DocsViewPane.renderChunksForFile
    ↓
UI updates with new docs
```

---

## Performance Characteristics

### Current Implementation

- **Change Detection**: O(1) - Merkle tree already computed
- **Chunk Comparison**: O(n) - Compare n chunks
- **Update**: O(n) - Rebuild all chunks even if 1 changed
- **Doc Generation**: O(n) - Generate for all chunks

### Optimized (Future)

- **Change Detection**: O(1) - Same
- **Chunk Comparison**: O(n) - Same
- **Update**: O(k) - Only update k changed chunks
- **Doc Generation**: O(k) - Only generate for k changed chunks

---

## Debouncing & Timing

### Why Debouncing?

1. **File Changes**: User might save multiple times quickly

   - Debounce: 500ms for active file changes
   - Prevents: Processing every single save

2. **Merkle Tree Changes**: Large files might trigger multiple updates
   - Debounce: 1000ms for Merkle tree changes
   - Prevents: Processing partial tree updates

### Example Timeline

```
T=0ms:   User saves file
T=50ms:  File system change detected
T=100ms: Merkle tree starts hashing
T=200ms: Merkle tree emits change event
T=1200ms: Docs agent processes (1000ms debounce)
T=1250ms: Chunks updated, docs regenerated
T=1300ms: UI updates
```

---

## Error Handling

### 1. Merkle Tree Not Initialized

```typescript
// If tree not ready, getFileChunks returns undefined
if (!fileChunks) {
	// Fallback: create single chunk for entire file
	await createSingleChunkForFile(uri);
}
```

### 2. Symbol Extraction Fails

```typescript
// If outline service fails, continue with empty symbols
try {
    symbols = await extractSymbolsForRange(...);
} catch (e) {
    console.warn('[DocsAgent] Failed to extract symbols:', e);
    return [];  // Continue with empty symbols
}
```

### 3. Storage Errors

```typescript
// If storage fails, log but continue
try {
    storageService.store(...);
} catch (e) {
    console.error('[ChunkIndexService] Failed to save:', e);
}
```

---

## Key Insights

### 1. Merkle Tree is Source of Truth

- Docs system doesn't compute chunks itself
- Always gets chunks from MerkleTreeService
- Merkle tree handles file reading, chunking, hashing

### 2. Chunk Hash = Content Fingerprint

- Hash changes when chunk content changes
- Hash stays same when chunk unchanged
- Enables exact change detection

### 3. Sequential vs Hierarchical

- `parentHash`: Sequential link (previous chunk)
- `children`: Hierarchical link (semantic grouping)
- Both can coexist in same chunk

### 4. Incremental Updates Are Key

- Current: Rebuilds all when any change
- Future: Only update changed chunks
- Performance: 10x faster for typical changes

---

## Example: Real-World Scenario

### Scenario: User edits line 50 in 600-line file

**Step 1: File Change**

```
File: src/utils.ts (600 lines)
User edits line 50
```

**Step 2: Merkle Tree Reacts**

```
MerkleTreeBuilder.hashFileChunked()
  - Reads file
  - Finds chunk containing line 50 (chunk 1, lines 0-199)
  - Rehashes chunk 1: "abc123..." → "xyz999..."
  - Chunks 2 & 3 unchanged
  - Updates tree cache
```

**Step 3: Event Fired**

```
MerkleTreeService.onDidChangeTree.fire({
  oldHash: "root_old...",
  newHash: "root_new..."
})
```

**Step 4: Docs Agent Detects**

```
DocsAgent.handleMerkleChangeForFile()
  - Gets current chunks: ["xyz999...", "def456...", "ghi789..."]
  - Gets old chunks: ["abc123...", "def456...", "ghi789..."]
  - Compares: Chunk 1 changed!
  - changedHashes = ["xyz999..."]
```

**Step 5: Current Implementation (Inefficient)**

```
removeChunksForFile(uri)  // Removes ALL 3 chunks
ensureChunksForFile(uri)  // Rebuilds ALL 3 chunks
  - Re-extracts symbols for all chunks
  - Re-stores all chunks
  - Regenerates docs for all 3 chunks
```

**Step 6: Optimized Implementation (Future)**

```
updateOnlyChangedChunks(uri, [0])  // Only update chunk at index 0
  - Re-extract symbols for chunk 1 only
  - Update chunk 1 in index
  - Regenerate doc for chunk 1 only
  - Chunks 2 & 3 untouched (no work done!)
```

**Result:**

- Current: 3 chunks processed, 3 docs regenerated
- Optimized: 1 chunk processed, 1 doc regenerated
- **67% reduction in work!**

---

## Summary

The docs system leverages Merkle tree's chunk-level hashing to:

1. **Detect exact changes** at chunk granularity
2. **Track chunk metadata** (symbols, ranges, relationships)
3. **Generate documentation** per chunk
4. **Update incrementally** when chunks change

The integration is efficient because:

- Merkle tree already does the expensive work (hashing)
- Docs system just reacts to Merkle tree events
- No duplicate file reading or hashing
- Change detection is O(1) (hash comparison)

Future optimization will make updates O(k) instead of O(n) where k = changed chunks.
