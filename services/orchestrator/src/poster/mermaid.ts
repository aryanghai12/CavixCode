import type { CallTrace } from "@cavix/analyzer";

// The sequence diagram, as GitHub will actually render it.
//
// GitHub parses ```mermaid blocks natively, which is the only reason this is
// worth doing: no image host, no shields.io, nothing to break behind an air gap.
// It also means a syntax error is not a missing diagram, it is a red error box
// sitting in the middle of a customer's pull request description under Cavix's
// name. So everything here is defensive by default:
//
//   - Identifiers are generated (P0, P1), never taken from a path. A file called
//     `end.ts` or `loop.js` would otherwise emit a Mermaid keyword as an alias.
//   - Every piece of display text is stripped to a known-safe alphabet. Mermaid
//     reads `#` as the start of an entity code, `;` as a statement separator,
//     `<` as markup, and a newline as the end of the statement. Any one of them
//     turns the block red.
//   - The block is capped upstream (see traceSequence) and says so when it was.
//
// The Cavix house style applies here too: no emoji, plain ASCII punctuation.

/**
 * Mermaid statements run to end of line, so text must survive on one line.
 *
 * Unicode letters, marks and digits are allowed through deliberately. Every
 * language Cavix parses permits them in identifiers, and a stripped `ü` turns
 * `über()` into `ber()`, which is not a sanitised label but a wrong one. A
 * reader who cannot find `ber` in their own file has been told something false
 * about their code, and that is a worse outcome than the red box this guards
 * against. What is blocked is the ASCII punctuation Mermaid assigns meaning to:
 * `#` (entity codes), `;` (statement separator), `:` (message delimiter), `<`
 * and `>` (markup and arrows), backticks, and anything that ends a line.
 */
const UNSAFE = /[^\p{L}\p{M}\p{N} ._/()[\]{}$*+=&|!?,'-]/gu;

/** How long a label may be before it starts making the diagram wider than the page. */
const MAX_LABEL = 44;

/**
 * Reduce text to something Mermaid cannot misread.
 *
 * Deliberately an allow-list. A deny-list of the characters known to break
 * Mermaid today is a promise about a parser we do not control, and the cost of
 * being wrong is a red box on somebody's pull request.
 */
export function mermaidText(raw: string, max = MAX_LABEL): string {
  const cleaned = raw.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return "?";
  // The ellipsis counts toward the cap. Appending it to `max - 1` characters
  // returns `max + 2`, so the guard was quietly wider than the number it named.
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

/**
 * Short, unambiguous labels for a set of file paths.
 *
 * The basename alone, until two files share one: `index.ts` and `index.ts` on
 * two lifelines is worse than no diagram, because the reader believes the arrow
 * points somewhere it does not. Colliding names fall back to `parent/basename`,
 * and if that still collides, the whole path.
 */
export function labelPaths(paths: string[]): Map<string, string> {
  const base = (p: string) => p.split("/").pop() ?? p;
  const withParent = (p: string) => p.split("/").slice(-2).join("/");

  const counts = new Map<string, number>();
  for (const p of paths) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1);

  const parentCounts = new Map<string, number>();
  for (const p of paths) parentCounts.set(withParent(p), (parentCounts.get(withParent(p)) ?? 0) + 1);

  const out = new Map<string, string>();
  for (const p of paths) {
    if ((counts.get(base(p)) ?? 0) === 1) out.set(p, base(p));
    else if ((parentCounts.get(withParent(p)) ?? 0) === 1) out.set(p, withParent(p));
    else out.set(p, p);
  }
  return out;
}

/**
 * Render a traced call path as a Mermaid sequence diagram.
 *
 * Returns [] when there is nothing to draw, so a caller can splice the result in
 * unconditionally and never produce an empty section.
 */
export function renderSequenceDiagram(trace: CallTrace | undefined): string[] {
  if (!trace || trace.steps.length === 0 || trace.participants.length < 2) return [];

  const labels = labelPaths(trace.participants);
  const alias = new Map<string, string>();
  trace.participants.forEach((p, i) => alias.set(p, `P${i}`));

  const out: string[] = ["### Call flow", "", "```mermaid", "sequenceDiagram"];
  for (const p of trace.participants) {
    out.push(`    participant ${alias.get(p)} as ${mermaidText(labels.get(p) ?? p)}`);
  }
  for (const s of trace.steps) {
    const from = alias.get(s.fromPath);
    const to = alias.get(s.toPath);
    // A step whose ends were never admitted as participants cannot be drawn.
    // traceSequence does not produce these; rendering one would be a red box.
    if (!from || !to) continue;
    out.push(`    ${from}->>${to}: ${mermaidText(`${s.toSymbol}()`)}`);
  }
  out.push("```");

  // The caption is the honest part. It names what the diagram is OF, so nobody
  // reads it as a picture of the whole system, and it admits when it was cut.
  const entry = trace.entryPoints.length > 0
    ? `Traced from ${trace.entryPoints.slice(0, 3).map((e) => `\`${e}\``).join(", ")}${trace.entryPoints.length > 3 ? " and others" : ""}, `
    : "Traced from the changed code, ";
  const scope = `across ${trace.participants.length} files, from the resolved call graph.`;
  const cut = trace.truncated ? " Longer paths exist; this is the first part of the flow." : "";
  out.push("", `<sub>${entry}${scope}${cut}</sub>`);

  return out;
}
