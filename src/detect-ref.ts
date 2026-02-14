/**
 * Auto-detect the upstream spec ref from the current git branch or environment.
 *
 * Rules:
 *   1. SPEC_REF env var (explicit override, always wins)
 *   2. Current git branch:
 *      - "main"       → "main"
 *      - "stable/X.Y" → "stable/X.Y"
 *      - anything else → "main" (with a warning)
 *   3. Falls back to "main" if git is unavailable
 */
import { execFileSync } from 'node:child_process';

export interface DetectRefResult {
  /** The resolved ref string. */
  ref: string;

  /** How the ref was determined. */
  source: 'env' | 'branch-match' | 'branch-fallback' | 'default';

  /** The raw git branch name (if detected). */
  branch?: string;
}

/**
 * Detect the upstream spec ref from the current git branch.
 *
 * Priority: SPEC_REF env var > git branch detection > "main" default.
 */
export function detectUpstreamRef(): DetectRefResult {
  const envRef = process.env['SPEC_REF'];
  if (envRef) {
    return { ref: envRef, source: 'env' };
  }

  let branch: string;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    })
      .toString()
      .trim();
  } catch {
    return { ref: 'main', source: 'default' };
  }

  if (branch === 'main') {
    return { ref: 'main', source: 'branch-match', branch };
  }

  if (branch.startsWith('stable/')) {
    return { ref: branch, source: 'branch-match', branch };
  }

  return { ref: 'main', source: 'branch-fallback', branch };
}
