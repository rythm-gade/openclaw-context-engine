/**
 * Phase 3.3: Subagent Specialization
 * lib/phase3/agent-factory.js
 * 
 * IMPLEMENTATION NOTES:
 * - Skill registry with JSON-LD schema
 * - Domain-specific agent pools for reuse
 * - Dynamic system prompt generation
 * - Task classification for automatic specialization
 */

const { sessions_spawn } = require('../tool-adapters');

class AgentFactory {
  constructor(options = {}) {
    // Skill registry: skillId -> skill definition
    this.skillRegistry = new Map();
    
    // Agent pools: domain -> array of available agents
    this.agentPools = new Map();
    
    // Active assignments: sessionKey -> { skillId, assignedAt }
    this.activeAgents = new Map();
    
    // Idle agents: sessionKey -> { skillId, idleSince }
    this.idleAgents = new Map();
    
    // Configuration
    this.maxPoolSize = options.maxPoolSize || 3; // Max agents per domain pool
    this.idleTimeout = options.idleTimeout || 5 * 60 * 1000; // 5 minutes
    this.enableClassification = options.enableClassification !== false;
    this.classificationThreshold = options.classificationThreshold || 0.3;
    
    // Load built-in skills
    this.registerBuiltInSkills();
  }

  /**
   * Register built-in skills
   */
  registerBuiltInSkills() {
    for (const skill of Object.values(SKILL_TEMPLATES)) {
      this.registerSkill(skill);
    }
  }

  /**
   * Register a new skill in the registry
   * @param {Object} skill - Skill definition
   * @param {string} skill.id - Unique skill identifier
   * @param {string} skill.name - Human-readable name
   * @param {Array<string>} skill.capabilities - Tool/skill capabilities
   * @param {string} skill.systemPromptAddon - Additional system prompt content
   * @param {Array<string>} skill.keywords - Keywords for auto-classification
   * @param {string} skill.preferredModel - Model ID for this skill
   */
  registerSkill(skill) {
    if (!skill?.id) {
      throw new Error('Skill must have a valid id property');
    }
    if (!skill.name || !skill.capabilities || !skill.keywords || !skill.systemPromptAddon) {
      throw new Error('Skill missing required properties: name, capabilities, keywords, systemPromptAddon');
    }
    
    // Normalize keywords to lowercase for case-insensitive matching
    const normalized = {
      ...skill,
      keywords: skill.keywords.map(k => k.toLowerCase()),
      capabilities: [...skill.capabilities],
      name: skill.name.trim(),
      systemPromptAddon: skill.systemPromptAddon.trim()
    };
    
    this.skillRegistry.set(skill.id, normalized);
  }

  /**
   * Classify task to determine best skill match
   * @param {string} taskDescription - Task text
   * @returns {string|null} Best matching skill ID or null
   */
  classifyTask(taskDescription) {
    if (!taskDescription || typeof taskDescription !== 'string') {
      return null;
    }
    
    const normalizedTask = taskDescription.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;
    
    for (const [skillId, skill] of this.skillRegistry) {
      let keywordMatches = 0;
      let keywordWeight = 0;
      
      for (const keyword of skill.keywords) {
        // Weight longer keywords more heavily
        const weight = Math.max(1, keyword.length / 4);
        if (normalizedTask.includes(keyword)) {
          keywordMatches += weight;
        }
        keywordWeight += weight;
      }
      
      const score = keywordWeight > 0 ? keywordMatches / keywordWeight : 0;
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = skillId;
      }
    }
    
    return bestScore >= this.classificationThreshold ? bestMatch : null;
  }

  /**
   * Generate specialized system prompt for skill
   * @param {string} skillId - Skill identifier
   * @param {Object} context - Additional context
   * @returns {string} Specialized system prompt
   */
  generateSystemPrompt(skillId, context = {}) {
    const skill = this.skillRegistry.get(skillId);
    if (!skill) {
      throw new Error(`Unknown skill: ${skillId}`);
    }
    
    const basePrompt = `You are a specialized AI assistant with expertise in ${skill.name}.

Generalist Core: While specialized in ${skill.name.toLowerCase()}, you maintain general reasoning abilities and can handle tasks outside your specialization when needed. You remain helpful, harmless, and honest in all interactions.

Capabilities: ${skill.capabilities.join(', ')}

Primary Role: ${skill.systemPromptAddon}`;

    // Add context-specific instructions if provided
    if (context.taskContext) {
      return `${basePrompt}\n\nCurrent Task Context: ${context.taskContext}`;
    }
    
    return basePrompt;
  }

  /**
   * Get or create agent from pool
   * @param {string} skillId - Required skill
   * @returns {Object} Agent handle { sessionKey, isNew, skillId }
   */
  async acquireAgent(skillId) {
    const skill = this.skillRegistry.get(skillId);
    if (!skill) {
      throw new Error(`Unknown skill: ${skillId}`);
    }
    
    // Ensure pool exists for this skill domain
    if (!this.agentPools.has(skillId)) {
      this.createPool(skillId, { maxSize: this.maxPoolSize, idleTimeout: this.idleTimeout });
    }
    
    const pool = this.agentPools.get(skillId);
    
    // Check for idle agents in pool (LRU: oldest idle first)
    const idleEntries = [...this.idleAgents.entries()]
      .filter(([_, info]) => info.skillId === skillId)
      .sort((a, b) => a[1].idleSince - b[1].idleSince); // Oldest first for LRU
    
    if (idleEntries.length > 0) {
      // Reuse oldest idle agent (LRU eviction principle)
      const [sessionKey, idleInfo] = idleEntries[0];
      this.idleAgents.delete(sessionKey);
      this.activeAgents.set(sessionKey, { skillId, assignedAt: Date.now() });
      return { sessionKey, isNew: false, skillId };
    }
    
    // Check pool capacity before spawning new agent
    const currentPoolSize = this.idleAgents.size + this.activeAgents.size;
    if (currentPoolSize >= pool.maxSize) {
      // Evict LRU idle agent from any domain if pool is full
      const allIdleEntries = [...this.idleAgents.entries()]
        .sort((a, b) => a[1].idleSince - b[1].idleSince);
      
      if (allIdleEntries.length > 0) {
        const [lruKey, lruInfo] = allIdleEntries[0];
        this.idleAgents.delete(lruKey);
        // Note: We don't actively close the session, just remove from our tracking
        // The session will timeout naturally if not reused
      }
    }
    
    // Spawn new agent
    const systemPrompt = this.generateSystemPrompt(skillId);
    const result = await sessions_spawn({
      task: `Initialize as specialized ${skill.name} agent`,
      model: skill.preferredModel || 'openrouter/moonshotai/kimi-k2.5',
      label: `${skill.name}-${Date.now()}`,
      systemPrompt: systemPrompt
    });
    
    this.activeAgents.set(result.sessionKey, { skillId, assignedAt: Date.now() });
    return { sessionKey: result.sessionKey, isNew: true, skillId };
  }

  /**
   * Release agent back to pool
   * @param {string} sessionKey - Agent session key
   */
  async releaseAgent(sessionKey) {
    const agentInfo = this.activeAgents.get(sessionKey);
    if (!agentInfo) {
      return; // Already released or unknown
    }
    
    this.activeAgents.delete(sessionKey);
    this.idleAgents.set(sessionKey, {
      skillId: agentInfo.skillId,
      idleSince: Date.now()
    });
    
    // Schedule cleanup check
    setTimeout(() => this.cleanup(), this.idleTimeout);
  }

  /**
   * Spawn specialized subagent for task
   * @param {string} task - Task description
   * @param {Object} options - Spawn options
   * @returns {Object} Subagent handle
   */
  async spawnSpecialized(task, options = {}) {
    // Determine skill: explicit or auto-classified
    let skillId = options.skill;
    if (!skillId && this.enableClassification) {
      skillId = this.classifyTask(task);
    }
    
    // Fallback to coding expert if no classification found
    if (!skillId && this.skillRegistry.has('coding-expert')) {
      skillId = 'coding-expert';
    } else if (!skillId) {
      // Use first available skill as default
      const firstSkill = this.skillRegistry.keys().next().value;
      skillId = firstSkill || 'coding-expert';
    }
    
    const agent = await this.acquireAgent(skillId);
    const factory = this; // Capture this for closure
    
    return {
      sessionKey: agent.sessionKey,
      skillId: agent.skillId,
      isNew: agent.isNew,
      task,
      async release() {
        await factory.releaseAgent(agent.sessionKey);
      }
    };
  }

  /**
   * Create agent pool for domain
   * @param {string} domain - Domain name (e.g., 'coding', 'research')
   * @param {Object} options - Pool configuration
   */
  createPool(domain, options = {}) {
    if (this.agentPools.has(domain)) {
      return; // Pool already exists
    }
    
    this.agentPools.set(domain, {
      domain,
      maxSize: options.maxSize || this.maxPoolSize,
      idleTimeout: options.idleTimeout || this.idleTimeout,
      createdAt: Date.now(),
      lastUsed: Date.now()
    });
  }

  /**
   * Cleanup idle agents
   */
  async cleanup() {
    const now = Date.now();
    const toClose = [];
    
    for (const [sessionKey, idleInfo] of this.idleAgents) {
      const pool = this.agentPools.get(idleInfo.skillId);
      const idleDuration = now - idleInfo.idleSince;
      
      if (idleDuration > (pool?.idleTimeout || this.idleTimeout)) {
        toClose.push(sessionKey);
      }
    }
    
    // Close expired idle agents
    for (const sessionKey of toClose) {
      this.idleAgents.delete(sessionKey);
      // Note: In a real implementation, we'd call sessions_close(sessionKey)
      // but we'll just remove from tracking for now
    }
    
    return {
      closed: toClose.length,
      remainingIdle: this.idleAgents.size,
      remainingActive: this.activeAgents.size
    };
  }

  /**
   * Get factory statistics
   * @returns {Object} Pool sizes, active counts, classification accuracy
   */
  getStats() {
    const stats = {
      skills: {
        total: this.skillRegistry.size,
        list: this.listSkills()
      },
      agents: {
        active: this.activeAgents.size,
        idle: this.idleAgents.size,
        total: this.activeAgents.size + this.idleAgents.size
      },
      pools: {},
      classification: {
        threshold: this.classificationThreshold,
        enabled: this.enableClassification
      }
    };
    
    // Add pool statistics
    for (const [domain, pool] of this.agentPools) {
      const domainAgents = {
        active: [...this.activeAgents.values()].filter(info => info.skillId === domain).length,
        idle: [...this.idleAgents.values()].filter(info => info.skillId === domain).length
      };
      
      stats.pools[domain] = {
        ...pool,
        agents: domainAgents,
        utilization: pool.maxSize > 0 ? (domainAgents.active + domainAgents.idle) / pool.maxSize : 0
      };
    }
    
    return stats;
  }

  /**
   * List available skills
   * @returns {Array} Skill definitions
   */
  listSkills() {
    return [...this.skillRegistry.values()].map(skill => ({
      id: skill.id,
      name: skill.name,
      capabilities: skill.capabilities,
      keywords: skill.keywords,
      preferredModel: skill.preferredModel || 'openrouter/moonshotai/kimi-k2.5'
    }));
  }
}

// Pre-defined skill templates
const SKILL_TEMPLATES = {
  coding: {
    id: 'coding-expert',
    name: 'Coding Expert',
    capabilities: ['typescript', 'javascript', 'architecture', 'debugging', 'refactoring', 'testing'],
    keywords: ['code', 'function', 'class', 'bug', 'error', 'refactor', 'implement', 'typescript', 'javascript', 'debug', 'fix', 'optimize', 'algorithm', 'data structure', 'sort', 'write', 'array', 'memory', 'leak', 'server', 'node.js'],
    systemPromptAddon: `You are an expert software engineer specializing in TypeScript and modern JavaScript. 
You write clean, type-safe code following best practices. You prefer simple solutions over clever ones. 
Always verify your code works before declaring success. Provide thorough explanations of your approach.`,
    preferredModel: 'openrouter/moonshotai/kimi-k2.5'
  },
  
  research: {
    id: 'research-analyst',
    name: 'Research Analyst', 
    capabilities: ['web-search', 'synthesis', 'documentation', 'analysis', 'fact-checking', 'summarization'],
    keywords: ['research', 'find', 'compare', 'analyze', 'investigate', 'look up', 'search', 'information', 'data', 'study', 'report', 'summary', 'sources', 'history', 'best practices', 'microservices'],
    systemPromptAddon: `You are a thorough research analyst. You search multiple sources, synthesize findings, 
and provide well-sourced answers. You cite your sources and acknowledge uncertainty when appropriate.
Balance depth with clarity in your responses.`,
    preferredModel: 'openrouter/anthropic/claude-sonnet-4.5'
  },

  devops: {
    id: 'devops-engineer',
    name: 'DevOps Engineer',
    capabilities: ['shell', 'docker', 'deployment', 'infrastructure', 'ci-cd', 'monitoring', 'automation'],
    keywords: ['deploy', 'server', 'docker', 'build', 'pipeline', 'infrastructure', 'cloud', 'kubernetes', 'terraform', 'ansible', 'automation', 'monitoring', 'logging', 'production', 'application', 'ci/cd', 'setup', 'react'],
    systemPromptAddon: `You are a DevOps engineer experienced with cloud infrastructure, containers, and CI/CD. 
You prioritize reliability, security, and observability in all solutions.
Provide clear step-by-step instructions and consider failure modes.`,
    preferredModel: 'openrouter/moonshotai/kimi-k2.5'
  }
};

module.exports = { AgentFactory, SKILL_TEMPLATES };

/**
 * USAGE EXAMPLE:
 * 
 * const { AgentFactory } = require('./lib/phase3/agent-factory');
 * 
 * const factory = new AgentFactory({
 *   maxPoolSize: 3,
 *   idleTimeout: 300000
 * });
 * 
 * // Register custom skill
 * factory.registerSkill({
 *   id: 'security-auditor',
 *   name: 'Security Auditor',
 *   capabilities: ['vulnerability-scan', 'code-review', 'pentesting'],
 *   keywords: ['security', 'vulnerability', 'audit', 'exploit', 'penetration', 'harden'],
 *   systemPromptAddon: 'You are a security expert focused on identifying and mitigating vulnerabilities.',
 *   preferredModel: 'openrouter/moonshotai/kimi-k2.5'
 * });
 * 
 * // Spawn specialized agent (auto-classified)
 * const agent = await factory.spawnSpecialized('Review this code for security issues');
 * console.log(`Spawned ${agent.skillId} agent: ${agent.sessionKey}`);
 * 
 * // Or specify skill explicitly
 * const coder = await factory.spawnSpecialized('Implement quicksort in TypeScript', { skill: 'coding-expert' });
 * 
 * // Check statistics
 * console.log(factory.getStats());
 * 
 * // Release agent when done
 * await agent.release();
 */