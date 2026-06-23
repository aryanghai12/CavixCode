import type { PolicyContext, PolicyRule, PolicyViolation } from "../types.ts";

// A second, deliberately non-security example: an org bans certain imports
// (a deprecated lib, a legacy internal module, a license-incompatible package).
// Pure governance — illustrates that the gate is a generic policy mechanism, not
// a security scanner. Banned modules come from org config (options.modules).

export const bannedImport: PolicyRule = {
  id: "banned-import",
  title: "Import of a module banned by org policy",
  severity: "medium",
  category: "governance",
  evaluate(ctx: PolicyContext): PolicyViolation[] {
    const banned = Array.isArray(ctx.options.modules) ? (ctx.options.modules as string[]) : [];
    if (banned.length === 0) return [];
    const bannedSet = new Set(banned);
    const out: PolicyViolation[] = [];
    for (const file of ctx.files) {
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const mod = importedModule(lines[i]);
        if (mod && bannedSet.has(mod)) {
          out.push({
            path: file.path,
            line: i + 1,
            message: `Module "${mod}" is banned by org policy. Use the approved alternative.`,
          });
        }
      }
    }
    return out;
  },
};

function importedModule(line: string): string | null {
  let m = /^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"']+)["']/.exec(line);
  if (m) return m[1];
  m = /\brequire\(\s*["']([^"']+)["']\s*\)/.exec(line);
  if (m) return m[1];
  m = /^\s*from\s+([\w.]+)\s+import\b/.exec(line);
  if (m) return m[1];
  return null;
}
