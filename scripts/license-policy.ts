// Pure evaluation of the dependency licence policy (ADR 0002). I/O lives in licenses.ts.
import satisfies from 'spdx-satisfies';

export interface ApprovedException {
  /** npm package name; applies to every version. */
  package: string;
  /** The SPDX licence we take the package under. */
  license: string;
  /** Issue or PR that approved it, and the obligations it carries. */
  approvedIn: string;
  obligations: string;
}

export interface LicensePolicy {
  allowed: string[];
  approvedExceptions: ApprovedException[];
}

export interface DependencyLicense {
  name: string;
  version: string;
  /** SPDX expression(s) as reported by license-checker; several entries mean "unclear". */
  licenses: string[];
}

export type Verdict = { ok: true; via: 'allowed' | 'exception' } | { ok: false; reason: string };

/** license-checker marks licences guessed from a file with a trailing `*`. */
function normalise(license: string): string {
  return license.trim().replace(/\*$/, '');
}

function satisfiesSafe(expression: string, approved: string[]): boolean {
  try {
    return satisfies(expression, approved);
  } catch {
    // Not a valid SPDX expression (e.g. "UNKNOWN", "Custom: ..."), so it can't satisfy anything.
    return false;
  }
}

export function evaluate(dep: DependencyLicense, policy: LicensePolicy): Verdict {
  const licenses = dep.licenses.map(normalise).filter((l) => l !== '');
  if (licenses.length === 0) return { ok: false, reason: 'no licence found' };

  // Several reported licences means license-checker couldn't settle on one; every one must pass.
  if (licenses.every((l) => satisfiesSafe(l, policy.allowed))) return { ok: true, via: 'allowed' };

  const exceptions = policy.approvedExceptions
    .filter((e) => e.package === dep.name)
    .map((e) => e.license);
  if (
    exceptions.length > 0 &&
    licenses.every((l) => satisfiesSafe(l, [...policy.allowed, ...exceptions]))
  ) {
    return { ok: true, via: 'exception' };
  }

  return {
    ok: false,
    reason: `${licenses.join(', ')} is not allowed and has no approved exception`,
  };
}
