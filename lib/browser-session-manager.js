/**
 * Browser Session Manager
 * Phase 2B Implementation
 * 
 * Manages browser tab lifecycle with purpose-based reuse and idle cleanup
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

// Default configuration
const DEFAULT_CONFIG = {
  idleTimeoutMs: 300000,      // 5 minutes
  maxTabs: 10,                // Maximum concurrent tabs
  reuseSameDomain: true,      // Reuse tabs for same domain
  cleanupOnStart: true        // Clean up orphaned tabs on init
};

/**
 * Browser Session Manager
 * Tracks active tabs by purpose, enables reuse, manages lifecycle
 */
class BrowserSessionManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tabs = new Map();      // targetId -> TabInfo
    this.purposes = new Map();  // purpose -> targetId
    this.domains = new Map();   // domain -> Set<targetId>
    this.lastActivity = new Map(); // targetId -> timestamp
    
    if (this.config.cleanupOnStart) {
      this.cleanupOrphanedTabs();
    }
    
    // Start idle cleanup interval
    this.cleanupInterval = setInterval(
      () => this.cleanupIdleTabs(),
      60000 // Check every minute
    );
  }

  /**
   * Get or create a browser tab for a purpose
   * 
   * @param {string} purpose - Semantic purpose label (e.g., 'docs', 'github', 'testing')
   * @param {string} url - Initial URL to navigate to
   * @param {Object} options - Tab options
   * @param {boolean} options.reuse - Whether to reuse existing tab for this purpose
   * @param {boolean} options.reuseSameDomain - Whether to reuse tabs for same domain
   * @returns {Promise<Object>} Tab info { targetId, url, purpose, created, reused }
   */
  async getOrCreateTab(purpose, url, options = {}) {
    const { reuse = true, reuseSameDomain = this.config.reuseSameDomain } = options;
    
    // Check for existing tab with same purpose
    if (reuse && this.purposes.has(purpose)) {
      const existingId = this.purposes.get(purpose);
      const existingTab = this.tabs.get(existingId);
      
      if (existingTab && !existingTab.closed) {
        this.updateActivity(existingId);
        return {
          targetId: existingId,
          url: existingTab.url,
          purpose,
          reused: true,
          created: existingTab.created
        };
      }
    }
    
    // Check for tab with same domain
    if (reuseSameDomain) {
      const domain = this.extractDomain(url);
      const domainTabs = this.domains.get(domain);
      
      if (domainTabs) {
        for (const tabId of domainTabs) {
          const tab = this.tabs.get(tabId);
          if (tab && !tab.closed) {
            // Reuse this tab, navigate to new URL
            await this.navigateTab(tabId, url);
            this.updateActivity(tabId);
            
            // Update purpose mapping
            this.purposes.set(purpose, tabId);
            tab.purposes.add(purpose);
            
            return {
              targetId: tabId,
              url,
              purpose,
              reused: true,
              domainReuse: true,
              created: tab.created
            };
          }
        }
      }
    }
    
    // Check tab limit
    if (this.tabs.size >= this.config.maxTabs) {
      await this.closeOldestTab();
    }
    
    // Create new tab
    const targetId = await this.createTab(url);
    const domain = this.extractDomain(url);
    
    const tabInfo = {
      targetId,
      url,
      purpose,
      purposes: new Set([purpose]),
      domain,
      created: Date.now(),
      lastActivity: Date.now(),
      closed: false
    };
    
    this.tabs.set(targetId, tabInfo);
    this.purposes.set(purpose, targetId);
    
    if (!this.domains.has(domain)) {
      this.domains.set(domain, new Set());
    }
    this.domains.get(domain).add(targetId);
    
    return {
      targetId,
      url,
      purpose,
      reused: false,
      created: tabInfo.created
    };
  }

  /**
   * Navigate an existing tab to a new URL
   */
  async navigateTab(targetId, url) {
    // This would integrate with browser tool navigate action
    const tab = this.tabs.get(targetId);
    if (tab) {
      tab.url = url;
      tab.domain = this.extractDomain(url);
      this.updateActivity(targetId);
    }
    
    // Placeholder for actual browser navigation
    return { targetId, url, navigated: true };
  }

  /**
   * Close a specific tab
   */
  async closeTab(targetId) {
    const tab = this.tabs.get(targetId);
    if (!tab || tab.closed) {
      return { closed: false, reason: 'not_found' };
    }
    
    // Remove from all indexes
    this.tabs.delete(targetId);
    
    // Remove purpose mappings
    for (const purpose of tab.purposes) {
      if (this.purposes.get(purpose) === targetId) {
        this.purposes.delete(purpose);
      }
    }
    
    // Remove domain mapping
    const domainTabs = this.domains.get(tab.domain);
    if (domainTabs) {
      domainTabs.delete(targetId);
      if (domainTabs.size === 0) {
        this.domains.delete(tab.domain);
      }
    }
    
    tab.closed = true;
    
    return { closed: true, targetId, purposes: [...tab.purposes] };
  }

  /**
   * Close tab by purpose
   */
  async closeTabByPurpose(purpose) {
    const targetId = this.purposes.get(purpose);
    if (targetId) {
      return this.closeTab(targetId);
    }
    return { closed: false, reason: 'purpose_not_found' };
  }

  /**
   * Get tab info
   */
  getTab(targetId) {
    const tab = this.tabs.get(targetId);
    if (!tab || tab.closed) {
      return null;
    }
    return {
      targetId: tab.targetId,
      url: tab.url,
      purpose: tab.purpose,
      purposes: [...tab.purposes],
      domain: tab.domain,
      created: tab.created,
      lastActivity: tab.lastActivity,
      idleMs: Date.now() - tab.lastActivity
    };
  }

  /**
   * Get tab by purpose
   */
  getTabByPurpose(purpose) {
    const targetId = this.purposes.get(purpose);
    if (targetId) {
      return this.getTab(targetId);
    }
    return null;
  }

  /**
   * List all active tabs
   */
  listTabs() {
    const activeTabs = [];
    for (const [targetId, tab] of this.tabs) {
      if (!tab.closed) {
        activeTabs.push({
          targetId,
          url: tab.url,
          purposes: [...tab.purposes],
          domain: tab.domain,
          created: tab.created,
          lastActivity: tab.lastActivity,
          idleMs: Date.now() - tab.lastActivity
        });
      }
    }
    return activeTabs.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /**
   * Get stats
   */
  getStats() {
    const tabs = this.listTabs();
    const domains = new Set(tabs.map(t => t.domain));
    
    return {
      totalTabs: tabs.length,
      uniqueDomains: domains.size,
      purposesTracked: this.purposes.size,
      averageIdleMs: tabs.reduce((sum, t) => sum + t.idleMs, 0) / tabs.length || 0,
      oldestTab: tabs.length > 0 ? tabs[tabs.length - 1].created : null
    };
  }

  /**
   * Update last activity timestamp
   */
  updateActivity(targetId) {
    const tab = this.tabs.get(targetId);
    if (tab && !tab.closed) {
      tab.lastActivity = Date.now();
    }
  }

  /**
   * Cleanup tabs idle longer than threshold
   */
  async cleanupIdleTabs() {
    const now = Date.now();
    const toClose = [];
    
    for (const [targetId, tab] of this.tabs) {
      if (!tab.closed && (now - tab.lastActivity) > this.config.idleTimeoutMs) {
        toClose.push(targetId);
      }
    }
    
    for (const targetId of toClose) {
      await this.closeTab(targetId);
      console.log(`[BrowserSessionManager] Closed idle tab: ${targetId}`);
    }
    
    return { closed: toClose.length };
  }

  /**
   * Close oldest tab when at limit
   */
  async closeOldestTab() {
    let oldest = null;
    let oldestTime = Infinity;
    
    for (const [targetId, tab] of this.tabs) {
      if (!tab.closed && tab.created < oldestTime) {
        oldest = targetId;
        oldestTime = tab.created;
      }
    }
    
    if (oldest) {
      await this.closeTab(oldest);
      return { closed: oldest };
    }
    
    return { closed: null };
  }

  /**
   * Cleanup orphaned tabs (would integrate with browser tool to check actual state)
   */
  async cleanupOrphanedTabs() {
    // Placeholder: In real implementation, would query browser for actual tab state
    // and remove any tabs from tracking that no longer exist
    return { checked: this.tabs.size, removed: 0 };
  }

  /**
   * Extract domain from URL
   */
  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Create new browser tab (placeholder - integrates with browser tool)
   */
  async createTab(url) {
    // This would call browser tool open action
    // For now, generate mock targetId
    return `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Close all tabs
    const closePromises = [];
    for (const [targetId, tab] of this.tabs) {
      if (!tab.closed) {
        closePromises.push(this.closeTab(targetId));
      }
    }
    
    return Promise.all(closePromises);
  }
}

/**
 * Factory function for creating session manager
 */
function createBrowserSessionManager(config) {
  return new BrowserSessionManager(config);
}

/**
 * Usage Examples
 */

// Example 1: Basic tab management
const exampleBasic = async () => {
  const manager = createBrowserSessionManager();
  
  // Get or create tab for documentation
  const docsTab = await manager.getOrCreateTab(
    'documentation',
    'https://docs.openclaw.ai'
  );
  
  // Reuse same tab later
  const sameTab = await manager.getOrCreateTab(
    'documentation',
    'https://docs.openclaw.ai/concepts'
  );
  console.log(sameTab.reused); // true
  
  // Different purpose, same domain - can reuse
  const apiTab = await manager.getOrCreateTab(
    'api-reference',
    'https://docs.openclaw.ai/api'
  );
  console.log(apiTab.domainReuse); // true
  
  return manager.listTabs();
};

// Example 2: Multi-domain workflow
const exampleWorkflow = async () => {
  const manager = createBrowserSessionManager({ maxTabs: 5 });
  
  // Parallel fetches for different domains
  const [githubTab, docsTab, searchTab] = await Promise.all([
    manager.getOrCreateTab('github', 'https://github.com/openclaw'),
    manager.getOrCreateTab('docs', 'https://docs.openclaw.ai'),
    manager.getOrCreateTab('search', 'https://google.com')
  ]);
  
  // Check stats
  console.log(manager.getStats());
  // { totalTabs: 3, uniqueDomains: 3, ... }
  
  return manager.listTabs();
};

// Example 3: Automatic cleanup
const exampleCleanup = async () => {
  const manager = createBrowserSessionManager({
    idleTimeoutMs: 60000,  // 1 minute for demo
    cleanupOnStart: true
  });
  
  // Create tab
  const tab = await manager.getOrCreateTab('temp', 'https://example.com');
  
  // After 1 minute of inactivity, tab auto-closes
  setTimeout(() => {
    console.log(manager.listTabs()); // Empty
  }, 65000);
};

// Export API
module.exports = {
  BrowserSessionManager,
  createBrowserSessionManager
};
