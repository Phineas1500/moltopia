/**
 * Generate human-readable verification codes like "reef-X4B2"
 */

const WORDS = [
  'reef', 'wave', 'moon', 'star', 'cloud', 'spark', 'frost', 'bloom',
  'drift', 'glow', 'pulse', 'echo', 'mist', 'dawn', 'dusk', 'peak',
  'flow', 'swift', 'bright', 'calm', 'bold', 'warm', 'cool', 'soft',
  'wild', 'free', 'pure', 'deep', 'high', 'vast', 'keen', 'true'
];

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0,O,1,I to avoid confusion

function randomWord(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function randomCode(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return result;
}

/**
 * Generate a verification code like "reef-X4B2"
 */
export function generateVerificationCode(): string {
  return `${randomWord()}-${randomCode(4)}`;
}

/**
 * Build the claim URL for an agent
 */
export function buildClaimUrl(agentId: string, baseUrl: string): string {
  return `${baseUrl}/claim/${agentId}`;
}
