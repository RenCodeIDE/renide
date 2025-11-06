# Chunk Hash Propagation & Update Strategy

## Current State Analysis

### How Merkle Tree Handles It (Reference)

- **Pattern**: Upward propagation (child → parent → root)
- **Method**: `updateParentHashes()` walks from changed file up to root
- **Why**: Parent hashes are **derived from children**, so they MUST update when children change
- **Performance**: Only changed nodes recalculated, parents bubble up

### Current Chunk Docs Implementation Issues

1. **Sequential parentHash doesn't change** - This is correct! `parentHash` points to the previous chunk sequentially, not a dependent hash
2. **Inefficient update**: When chunks change, we remove ALL chunks and rebuild (line 187-188 in docsAgent)
3. **No file-level hash tracking**: We don't track a file-level hash that aggregates all chunks
4. **Missing incremental updates**: Should update only changed chunks, not all

## Optimal Strategy

### Key Insight: Two Types of Relationships

1. **Sequential `parentHash`**:

   - Points to previous chunk in file order
   - **Does NOT change** when chunk content changes
   - Only changes if chunk order changes (rare)

2. **File-level hash** (NEW):
   - Aggregates all chunk hashes
   - **DOES change** when any chunk changes
   - Used for quick file-level change detection

### Proposed Solution: Incremental Update with Upward Propagation

#### Phase 1: Track File-Level Hash

```typescript
interface ChunkRecord {
	// ... existing fields
	fileHash?: string; // NEW: Hash of all chunks in file
}
```

#### Phase 2: Incremental Chunk Updates

When Merkle tree detects chunk changes:

1. **Compare hashes** (already done)
2. **Update only changed chunks** in index (don't remove all!)
3. **Recalculate file-level hash** from all chunk hashes
4. **Regenerate docs only for changed chunks**

#### Phase 3: Optimized Update Flow

```
File Change Detected
    ↓
Get changed chunks from Merkle service (already has this!)
    ↓
For each changed chunk:
  - Update chunk in index (upsertChunk)
  - Regenerate docs for that chunk only
    ↓
Recalculate file-level hash (from all chunks)
    ↓
Done! (No full rebuild needed)
```

## Performance Comparison

### Current Approach (Inefficient)

```
1 chunk changes → Remove ALL chunks → Rebuild ALL chunks → Regenerate ALL docs
Time: O(n) where n = total chunks
```

### Optimized Approach

```
1 chunk changes → Update 1 chunk → Regenerate 1 doc → Update file hash
Time: O(1) for update, O(n) only for file hash (but cheap)
```

## Implementation Plan

### Step 1: Add File-Level Hash Tracking

- Add `fileHash` to ChunkRecord (optional, for file-level queries)
- Calculate when chunks are created/updated
- Store in index or separate file metadata

### Step 2: Optimize Update Logic in docsAgent

- Replace `removeChunksForFile` + `ensureChunksForFile` with incremental updates
- Use `getChangedChunks()` from Merkle service to get exact changed indices
- Update only changed chunks via `upsertChunk`

### Step 3: Smart Chunk Comparison

- Use Merkle service's `getChangedChunks()` which already does this efficiently
- Compare by index AND hash (handles insertions/deletions)

### Step 4: Batch Updates

- Collect all changed chunks
- Batch update to storage (single write)
- Regenerate docs in parallel (up to concurrency limit)

## Code Changes Needed

### 1. Update docsAgent.contribution.ts

```typescript
// OLD (inefficient):
await this.chunkIndexService.removeChunksForFile(uri);
await this.ensureChunksForFile(uri);

// NEW (optimized):
const changed = await this.merkleTreeService.getChangedChunks(
	relativePath,
	oldChunks
);
for (const chunkIndex of changed.changed) {
	// Update only changed chunks
	await this.updateSingleChunk(uri, currentChunks[chunkIndex]);
}
```

### 2. Add File Hash Calculation

```typescript
async calculateFileHash(chunks: ChunkRecord[]): Promise<string> {
  const chunkHashes = chunks.map(c => c.hash).sort();
  return hashString(`file:${chunkHashes.join('|')}`);
}
```

### 3. Update ChunkIndexService

- Add method: `updateChunksIncremental(uri, changedChunks)`
- Add method: `getFileHash(uri)` - returns file-level hash
- Keep `parentHash` as-is (sequential, doesn't propagate)

## Why NOT Update parentHash?

- `parentHash` is **sequential ordering**, not **dependency**
- If Chunk 2 changes, Chunk 3's `parentHash` still points to Chunk 2 (correct!)
- We don't need to update parentHash unless chunks are reordered
- Sequential relationship is independent of content changes

## Why Track File-Level Hash?

- Quick file-level change detection
- Enables caching: "Has this file changed since last doc generation?"
- Can be used for file-level docs aggregation
- Follows Merkle tree pattern (file is parent of chunks)

## Performance Gains

- **90%+ reduction** in updates when 1 chunk changes in 10-chunk file
- **Parallel doc generation** for multiple changed chunks
- **Batch storage writes** instead of per-chunk writes
- **Smart caching**: Skip unchanged chunks entirely

## Migration Strategy

1. Keep current implementation working
2. Add optimized path alongside current path
3. Feature flag to switch between old/new
4. Test with various file sizes
5. Switch to optimized by default
6. Remove old path after validation
