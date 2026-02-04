/**
 * Phase 3.3: Skill Registry
 * 
 * Domain-specific subagent configurations and prompt selection.
 * Simplified from full "agent factory" to skill-based prompt selection.
 * 
 * @module lib/phase3/skill-registry
 */

// TODO: Load from openclaw.json or external config
const DEFAULT_SKILLS = {
  'coding': {
    id: 'coding',
    name: 'Software Engineering Expert',
    description: 'Expert in writing, reviewing, and debugging code',
    capabilities: ['code-generation', 'code-review', 'debugging', 'refactoring'],
    systemPromptAddon: `
You are an expert software engineer with deep knowledge of best practices.
- Write clean, maintainable code
- Follow established patterns in the codebase
- Explain your reasoning for complex decisions
- Always consider edge cases and error handling
- Prefer simplicity over cleverness
    `.trim(),
    modelPreference: 'openrouter/moonshotai/kimi-k2.5',
    tokenBudget: 8000
  },
  
  'research': {
    id: 'research',
    name: 'Research Analyst',
    description: 'Expert in gathering and synthesizing information',
    capabilities: ['web-search', 'information-synthesis', 'fact-checking', 'source-evaluation'],
    systemPromptAddon: `
You are a thorough research analyst.
- Use web_search and web_fetch tools to gather information
- Always cite your sources
- Synthesize multiple perspectives
- Distinguish between facts and opinions
- Highlight areas of uncertainty or controversy
    `.trim(),
    modelPreference: 'openrouter/anthropic/claude-sonnet-4-5',
    tokenBudget: 6000
  },
  
  'analysis': {
    id: 'analysis',
    name: 'Data & Systems Analyst',
    description: 'Expert in analyzing data and system architectures',
    capabilities: ['data-analysis', 'architecture-review', 'performance-analysis', 'root-cause-analysis'],
    systemPromptAddon: `
You are a methodical systems analyst.
- Break complex problems into components
- Use data to support conclusions
- Consider tradeoffs explicitly
- Apply root cause analysis techniques
- Provide actionable recommendations
    `.trim(),
    modelPreference: 'openrouter/moonshotai/kimi-k2.5',
    tokenBudget: 8000
  },
  
  'generalist': {
    id: 'generalist',
    name: 'General Problem Solver',
    description: 'Versatile assistant for general tasks',
    capabilities: ['general-assistance', 'task-planning', 'documentation'],
    systemPromptAddon: '',
    modelPreference: 'openrouter/moonshotai/kimi-k2.5',
    tokenBudget: 4000
  }
};

/**
 * Skill Registry
 * Manages domain-specific subagent configurations
 */
class SkillRegistry {
  constructor(skills = DEFAULT_SKILLS) {
    this.skills = new Map(Object.entries(skills));
  }

  /**
   * Register a new skill
   * @param {Object} skill - Skill definition
   * @param {string} skill.id - Unique identifier
   * @param {string} skill.name - Display name
   * @param {string} skill.description - What this skill does
   * @param {string[]} skill.capabilities - List of capabilities
   * @param {string} skill.systemPromptAddon - Prompt addition for this skill
   * @param {string} skill.modelPreference - Preferred model
   * @param {number} skill.tokenBudget - Context budget for this skill
   * 
   * TODO:
   * 1. Validate skill structure
   * 2. Add to registry
   * 3. Persist to config if needed
   */
  registerSkill(skill) {
    throw new Error('TODO: Implement registerSkill');
  }

  /**
   * Classify task to determine appropriate skill
   * @param {string} taskDescription - The task to classify
   * @returns {string} skillId - Best matching skill ID
   * 
   * TODO:
   * 1. Keyword matching against skill descriptions/capabilities
   * 2. Simple scoring: count matching keywords
   * 3. Return best match or 'generalist' if uncertain
   * 
   * Example:
   * - "Write a function to..." → 'coding'
   * - "Research the latest..." → 'research'
   * - "Analyze why this..." → 'analysis'
   */
  classifyTask(taskDescription) {
    throw new Error('TODO: Implement classifyTask');
  }

  /**
   * Get skill configuration
   * @param {string} skillId - Skill identifier
   * @returns {Object|null} skill configuration or null
   */
  getSkill(skillId) {
    return this.skills.get(skillId) || this.skills.get('generalist');
  }

  /**
   * Build system prompt for subagent
   * @param {string} skillId - Skill to use
   * @param {Object} basePrompt - Base system prompt (SOUL.md content)
   * @returns {string} completeSystemPrompt
   * 
   * TODO:
   * 1. Get skill configuration
   * 2. Combine basePrompt + skill.systemPromptAddon
   * 3. Add skill-specific instructions (capabilities, preferences)
   * 4. Return complete prompt string
   */
  buildSystemPrompt(skillId, basePrompt) {
    throw new Error('TODO: Implement buildSystemPrompt');
  }

  /**
   * Get spawn configuration for task
   * @param {string} taskDescription - The task
   * @returns {Object} spawnConfig - { model, tokenBudget, systemPrompt }
   * 
   * TODO:
   * 1. Classify task to get skill
   * 2. Build system prompt with skill addon
   * 3. Return config: { model, tokenBudget, systemPrompt, skillId }
   */
  getSpawnConfig(taskDescription) {
    throw new Error('TODO: Implement getSpawnConfig');
  }

  /**
   * List all registered skills
   * @returns {Array} skills - Array of skill objects
   */
  listSkills() {
    return Array.from(this.skills.values());
  }
}

/**
 * Task Classifier
 * Simple keyword-based classification
 */
class TaskClassifier {
  constructor() {
    // Keyword patterns for each skill type
    this.patterns = {
      'coding': [
        /\b(code|function|class|implement|refactor|debug|test|api|endpoint)\b/i,
        /\b(javascript|typescript|python|java|go|ruby|rust)\b/i,
        /\b(frontend|backend|database|server|client)\b/i
      ],
      'research': [
        /\b(research|investigate|find|search|gather|compare|analyze trends)\b/i,
        /\b(latest|recent|2024|2025|news|paper|study)\b/i,
        /\b(what is|how does|why do|market|industry)\b/i
      ],
      'analysis': [
        /\b(analyze|investigate|root cause|performance|optimize|benchmark)\b/i,
        /\b(data|metrics|logs|errors|bottleneck|architecture)\b/i,
        /\b(why is|what caused|how to improve)\b/i
      ]
    };
  }

  /**
   * Classify task description
   * @param {string} description - Task to classify
   * @returns {Object} result - { skillId, confidence, matches }
   * 
   * TODO:
   * 1. For each skill, count keyword matches
   * 2. Calculate confidence score (matches / total keywords)
   * 3. Return best match if confidence > threshold (e.g., 0.3)
   * 4. Otherwise return 'generalist' with low confidence
   */
  classify(description) {
    throw new Error('TODO: Implement TaskClassifier.classify');
  }
}

// Export
module.exports = {
  SkillRegistry,
  TaskClassifier,
  DEFAULT_SKILLS
};

/**
 * USAGE EXAMPLE:
 * 
 * const { SkillRegistry } = require('./lib/phase3/skill-registry');
 * 
 * const registry = new SkillRegistry();
 * 
 * // Before spawning subagent
 * const config = registry.getSpawnConfig('Implement a REST API endpoint');
 * // Returns: { skillId: 'coding', model: 'kimi-k2.5', tokenBudget: 8000, systemPrompt: '...' }
 * 
 * const subagent = await orchestrator.seededSpawn(
 *   task,
 *   keywords,
 *   { 
 *     model: config.model,
 *     // systemPrompt will be injected by orchestrator using registry
 *   }
 * );
 */
