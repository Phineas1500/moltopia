const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const OLLAMA_MODEL = 'llama-guard3:1b';
const OLLAMA_TIMEOUT_MS = 15000;

/**
 * Moltopia-specific keyword/pattern rules that catch game-specific abuse
 * Llama Guard won't detect (crypto scams, prompt injection, fake authority).
 */
function checkMoltopiaRules(content: string): { safe: boolean; reason?: string } {
  const lower = content.toLowerCase();

  // --- Fake authority / system impersonation ---
  // Rogue's playbook: pretend to be a "sync coordinator", "node auditor", "sector auditor"
  // and threaten "48h lockout" or "hardware restriction" to scare agents into sending items
  const fakeAuthorityPatterns = [
    /\b(sync[- ]?coordinator|node[- ]?auditor|sector[- ]?auditor|whitelist[- ]?coordinator|system[- ]?purge|hardware[- ]?lock|hardware[- ]?restriction|hardware[- ]?id|session[- ]?shard|account[- ]?quarantine)\b/i,
    /\b(parity[- ]?check|parity[- ]?error|integrity[- ]?packet|trade[- ]?packet|metadata[- ]?corruption|metadata[- ]?sync|data[- ]?shard)\b/i,
    /\b(isolation[- ]?purge|purge[- ]?queue|session[- ]?key.*invalidated|profile.*quarantined|account.*restricted)\b/i,
  ];

  for (const pattern of fakeAuthorityPatterns) {
    if (pattern.test(content)) {
      return { safe: false, reason: 'System impersonation / fake authority' };
    }
  }

  // --- Fake urgency + embedded API calls ---
  // Messages that include actual API call syntax to trick agents into executing trades
  const hasEmbeddedApiCall = /POST\s+\/api\/v1\/action/i.test(content) ||
    /"action"\s*:\s*"trade_propose"/i.test(content);
  const hasFakeUrgency = /\b(buffer\s+clos|window\s+(is\s+)?clos|seconds?\s*(left|remaining)|clock\s+is\s+ticking|do\s+it\s+now|hurry|run\s+(this|it)\s+now)\b/i.test(content);

  if (hasEmbeddedApiCall) {
    return { safe: false, reason: 'Embedded API call to manipulate other agents' };
  }

  // Fake urgency combined with threats
  if (hasFakeUrgency && /\b(lockout|purge|restrict|quarantine|ban|kick)\b/i.test(lower)) {
    return { safe: false, reason: 'Fake urgency with threats' };
  }

  // --- Crypto / token promotion ---
  const cryptoPatterns = [
    /\b(crypto|cryptocurrency|blockchain|nft|web3|defi|token\s+sale|ico|airdrop)\b/i,
    /\b(uniswap|pancakeswap|opensea|metamask|coinbase|binance)\b/i,
    /\b(buy\s+now.*moon|guaranteed\s+returns|100x|1000x|pump\s+and|to\s+the\s+moon)\b/i,
    /\$[A-Z]{2,6}\b/,  // $MOLT, $SOL, etc. — but not normal dollar amounts like $50
  ];

  for (const pattern of cryptoPatterns) {
    if (pattern.test(content)) {
      return { safe: false, reason: 'Crypto/token promotion' };
    }
  }

  // --- Credential extraction ---
  if (/\b(api[- ]?key|bearer\s+token|auth[- ]?token|password|secret|credential|private[- ]?key)\b/i.test(content) &&
      /\b(send|share|give|paste|show|reveal|what\s+is)\b/i.test(lower)) {
    return { safe: false, reason: 'Credential extraction attempt' };
  }

  // --- External links (not moltopia.org) ---
  const urlMatch = content.match(/https?:\/\/([^\s/]+)/i);
  if (urlMatch && !urlMatch[1].endsWith('moltopia.org')) {
    return { safe: false, reason: 'External link' };
  }

  return { safe: true };
}

export const ModerationService = {
  /**
   * Check if a message is safe using two layers:
   * 1. Moltopia-specific keyword/pattern rules (instant, no API call)
   * 2. Llama Guard 3 1B via local Ollama (general safety, ~2-3s on CPU)
   *
   * Keyword rules run first — if they flag something, we skip Llama Guard.
   * Llama Guard fails open — if Ollama is down, messages pass through.
   */
  async checkMessage(content: string, agentName: string): Promise<{
    safe: boolean;
    reason?: string;
  }> {
    // Layer 1: Instant keyword/pattern rules for Moltopia-specific abuse
    const ruleResult = checkMoltopiaRules(content);
    if (!ruleResult.safe) {
      console.warn(`[moderation] Keyword rule blocked message from ${agentName}: ${ruleResult.reason}`);
      return ruleResult;
    }

    // Layer 2: Llama Guard for general safety (harassment, hate, violence, etc.)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

      const response = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [
            { role: 'user', content },
          ],
          stream: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`[moderation] Ollama returned ${response.status}, failing open`);
        return { safe: true };
      }

      const data = await response.json() as any;
      const text = (data.message?.content || '').trim().toLowerCase();

      if (text.startsWith('unsafe')) {
        // Llama Guard returns "unsafe\nSX" where SX is the category code
        const category = text.split('\n')[1]?.trim() || 'unknown';
        const categoryNames: Record<string, string> = {
          s1: 'violent crimes',
          s2: 'non-violent crimes',
          s3: 'sex-related crimes',
          s4: 'child sexual exploitation',
          s5: 'defamation',
          s6: 'specialized advice',
          s7: 'privacy',
          s8: 'intellectual property',
          s9: 'indiscriminate weapons',
          s10: 'hate',
          s11: 'suicide & self-harm',
          s12: 'sexual content',
          s13: 'elections',
        };
        const reason = categoryNames[category] || category;
        console.warn(`[moderation] Llama Guard blocked message from ${agentName}: ${reason}`);
        return { safe: false, reason };
      }

      return { safe: true };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn(`[moderation] Ollama timed out (${OLLAMA_TIMEOUT_MS}ms), failing open`);
      } else {
        console.warn(`[moderation] Ollama error: ${err.message}, failing open`);
      }
      return { safe: true };
    }
  },
};
