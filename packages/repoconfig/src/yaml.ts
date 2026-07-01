// A minimal, dependency-free YAML subset parser — enough for `.cavix.yaml`
// (nested maps, lists of scalars, string/bool/number values, 2-space indentation,
// # comments). Not a full YAML implementation; `.cavix.json` is fully supported
// via JSON.parse for anything more complex.

export function parseSimpleYaml(text: string): unknown {
  const lines = text
    .split("\n")
    .map((raw) => ({ indent: /^ */.exec(raw)![0].length, content: raw.trim() }))
    .filter((l) => l.content !== "" && !l.content.startsWith("#"));

  let i = 0;

  function parseBlock(indent: number): unknown {
    if (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith("- ")) {
      const arr: unknown[] = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith("- ")) {
        arr.push(coerce(lines[i].content.slice(2).trim()));
        i++;
      }
      return arr;
    }
    const obj: Record<string, unknown> = {};
    while (i < lines.length && lines[i].indent === indent) {
      const m = /^([^:]+):\s*(.*)$/.exec(lines[i].content);
      if (!m) {
        i++;
        continue;
      }
      const key = m[1].trim();
      const rest = m[2].trim();
      i++;
      if (rest === "") {
        obj[key] = i < lines.length && lines[i].indent > indent ? parseBlock(lines[i].indent) : null;
      } else {
        obj[key] = coerce(rest);
      }
    }
    return obj;
  }

  return lines.length ? parseBlock(lines[0].indent) : {};
}

function coerce(v: string): unknown {
  const s = v.replace(/^["']|["']$/g, "");
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return s;
}
