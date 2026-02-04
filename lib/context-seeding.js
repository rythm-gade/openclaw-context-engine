/**
 * Context Seeding System for Subagents
 * Phase 2B Implementation
 * 
 * Provides intelligent context injection for subagent spawning based on
 * memory search relevance, with compression and token budget management.
 */

const DEFAULT_CONFIG = {
  topK: 5,
  tokenBudget: 4000,
  compressionLevel: 'light',
  includeMetadata: true,
  modelBudgets: {
    'kimi-k2.5': 8000,
    'deepseek-v3': 6000,
    'gpt-4o': 4000,
    'claude-3.5': 6000,
    'default': 4000
  }
};

/**
 * Extract keywords from task description
 * Simple NLP: extract meaningful words, score by frequency + position
 */
function extractKeywords(task, maxKeywords = 5) {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that',
    'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they'
  ]);
  
  const words = task.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
  
  const scored = {};
  words.forEach((word, idx) => {
    if (!scored[word]) scored[word] = 0;
    scored[word] += 1 + (words.length - idx) / words.length;
  });

  return Object.entries(scored)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

/**
 * Calculate Jaccard similarity between two strings
 */
function jaccardSimilarity(str1, str2) {
  const set1 = new Set(str1.toLowerCase().split(/\s+/));
  const set2 = new Set(str2.toLowerCase().split(/\s+/));
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

/**
 * Calculate recency score (1.0 = today, 0.1 = 30+ days ago)
 */
function calculateRecencyScore(timestamp) {
  if (!timestamp) return 0.5;
  const daysAgo = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0.1, 1.0 - (daysAgo / 30));
}

/**
 * Get source priority for relevance calculation
 */
function getSourcePriority(source) {
  const priorities = {
    'MEMORY.md': 1.0,
    'AGENTS.md': 0.9,
    'SOUL.md': 0.9,
    'USER.md': 0.85,
    'daily': 0.7,
    'HEARTBEAT.md': 0.6,
    'default': 0.5
  };
  return priorities[source] || priorities.default;
}

/**
 * Rank and deduplicate memory chunks
 */
function rankAndDeduplicate(chunks, maxResults) {
  const scored = chunks.map(chunk => {
    const relevance = chunk.score || 0.5;
    const recency = calculateRecencyScore(chunk.timestamp);
    const sourcePriority = getSourcePriority(chunk.source);
    
    return {
      ...chunk,
      compositeScore: (relevance * 0.6) + (recency * 0.3) + (sourcePriority * 0.1)
    };
  });

  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  const unique = [];
  for (const chunk of scored) {
    const isDuplicate = unique.some(existing => 
      jaccardSimilarity(chunk.content || chunk.snippet || '', 
                       existing.content || existing.snippet || '') > 0.85
    );
    if (!isDuplicate) {
      unique.push(chunk);
      if (unique.length >= maxResults) break;
    }
  }

  return unique;
}

/**
 * Compress context to fit token budget
 */
function compressContext(chunks, options) {
  const { tokenBudget, compressionLevel, includeMetadata } = options;
  
  const contentBudget = Math.floor(tokenBudget * 0.8);
  const metadataBudget = Math.floor(tokenBudget * 0.15);
  
  const compressed = [];
  let usedTokens = 0;

  for (const chunk of chunks) {
    let content = chunk.content || chunk.snippet || '';
    
    if (compressionLevel === 'light') {
      content = content.substring(0, 500);
    } else if (compressionLevel === 'aggressive') {
      content = content.substring(0, 150);
    }

    const metadata = includeMetadata 
      ? `[${chunk.source}${chunk.timestamp ? ' | ' + chunk.timestamp : ''}] ` 
      : '';
    
    const estimatedTokens = Math.ceil((content.length + metadata.length) / 4);

    if (usedTokens + estimatedTokens > contentBudget + metadataBudget) {
      break;
    }

    compressed.push({
      content: metadata + content,
      originalSource: chunk.source,
      relevance: (chunk.compositeScore || chunk.score || 0.5).toFixed(2)
    });
    
    usedTokens += estimatedTokens;
  }

  return { chunks: compressed, usedTokens };
}

/**
 * Build seeded prompt with context
 */
function buildSeededPrompt(task, contextChunks, keywords) {
  const contextSection = contextChunks.length > 0
    ? `## Relevant Historical Context\n\n` + 
      contextChunks.map((c, i) => `${i + 1}. [Relevance: ${c.relevance}] ${c.content}`).join('\n\n')
    : '## No relevant historical context found.\n';

  return `You are a subagent spawned to complete a specific task. The following context has been seeded from memory search based on keywords: ${keywords.join(', ')}.

${contextSection}

---

## Your Task

${task}

## Instructions

1. Use the seeded context above to inform your work - this contains relevant historical decisions, preferences, and lessons learned.
2. If the context is insufficient, you may search memory again or ask for clarification.
3. Document any significant findings or decisions in memory for future reference.
4. Report back with clear, actionable results.
`;
}

/**
 * Estimate tokens from text (rough: 1 token ≈ 4 chars)
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Prepare spawn options with seeded context
 * Note: This returns the enhanced task with seeded context;
 * actual spawning uses OpenClaw's sessions_spawn tool
 */
async function prepareSeededSpawn(options, memorySearchFn) {
  const {
    task,
    keywords = [],
    model = 'default',
    topK = DEFAULT_CONFIG.topK,
    tokenBudget = DEFAULT_CONFIG.modelBudgets[model] || DEFAULT_CONFIG.tokenBudget,
    compressionLevel = DEFAULT_CONFIG.compressionLevel,
    includeMetadata = DEFAULT_CONFIG.includeMetadata
  } = options;

  // Extract or use provided keywords
  const searchKeywords = keywords.length > 0 
    ? keywords 
    : extractKeywords(task);

  // Run memory searches (caller provides memorySearchFn)
  const searchResults = await Promise.all(
    searchKeywords.map(keyword => memorySearchFn(keyword, { maxResults: topK * 2 }))
  );

  // Flatten results from all searches
  const allResults = searchResults.flatMap(r => r.results || r);

  // Rank and deduplicate
  const rankedChunks = rankAndDeduplicate(allResults, topK * 3);

  // Compress to fit budget
  const { chunks: compressedContext, usedTokens } = compressContext(rankedChunks, {
    tokenBudget,
    compressionLevel,
    includeMetadata
  });

  // Build seeded task
  const seededTask = buildSeededPrompt(task, compressedContext, searchKeywords);

  return {
    ...options,
    task: seededTask,
    originalTask: task,
    metadata: {
      seeded: true,
      keywords: searchKeywords,
      chunksInjected: compressedContext.length,
      estimatedTokens: usedTokens + estimateTokens(seededTask) - estimateTokens(task)
    }
  };
}

/**
 * Simplified API for direct use with OpenClaw's sessions_spawn
 */
async function seededSpawn(task, keywords, options = {}) {
  // This integrates with OpenClaw's actual tool system
  // Would need access to memory_search tool
  throw new Error('seededSpawn requires integration with OpenClaw tool system. Use prepareSeededSpawn() with your memorySearch function.');
}

// Export API
module.exports = {
  prepareSeededSpawn,
  extractKeywords,
  rankAndDeduplicate,
  compressContext,
  buildSeededPrompt,
  estimateTokens,
  DEFAULT_CONFIG
};
