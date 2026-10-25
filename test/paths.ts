// Where the tests find this checkout and the Agent Skill (#25), defined once (#124).
import { fileURLToPath } from 'node:url';

/** This checkout's root, absolute and ending in a separator. */
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The skill's name, from its SKILL.md frontmatter. */
export const SKILL_NAME = 'better-code-review';

/**
 * The skill's directory, relative to `REPO_ROOT` with `/` separators. The eval hashes paths under
 * it by name (input.ts), so it stays relative.
 */
export const SKILL_DIR = `skills/${SKILL_NAME}`;

/** Where an agent client installs the skill, relative to the repository it runs in. */
export const INSTALLED_SKILL_DIR = `.claude/skills/${SKILL_NAME}`;
