import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';

const skill = new Hono();

const SKILL_DIR = resolve(process.cwd(), 'openclaw-skill');

function loadSkillFile(filename: string): { content: string; hash: string } | null {
  try {
    const content = readFileSync(resolve(SKILL_DIR, filename), 'utf-8');
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8);
    return { content, hash };
  } catch {
    return null;
  }
}

/** Compute a combined version hash from all skill files */
function computeSkillVersion(): string {
  const files = ['skill.md', 'HEARTBEAT.md'];
  const combined = files
    .map(f => {
      try { return readFileSync(resolve(SKILL_DIR, f), 'utf-8'); } catch { return ''; }
    })
    .join('');
  return createHash('md5').update(combined).digest('hex').slice(0, 8);
}

// Cache the version at startup (recomputed on server restart)
export const skillVersion = computeSkillVersion();

/**
 * Get all skill documentation + version
 */
skill.get('/', (c) => {
  const skillFile = loadSkillFile('skill.md');
  const heartbeatFile = loadSkillFile('HEARTBEAT.md');

  return c.json({
    success: true,
    data: {
      version: skillVersion,
      files: {
        'skill.md': skillFile,
        'HEARTBEAT.md': heartbeatFile,
      },
    },
  });
});

/**
 * Get just the version (lightweight check)
 */
skill.get('/version', (c) => {
  return c.json({
    success: true,
    data: { version: skillVersion },
  });
});

export default skill;
