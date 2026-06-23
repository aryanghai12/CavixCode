import type { Finding } from "@cavix/core";

// A file presented to the deterministic stage. `content` is the new-version text,
// so line numbers in findings match the diff's new-file coordinates.
export interface SourceFile {
  path: string;
  content: string;
}

// A Scanner turns files into findings. Builtin scanners run in-process and
// hermetically; tool adapters shell out to external linters when installed.
export interface Scanner {
  readonly id: string;
  run(files: SourceFile[]): Promise<Finding[]>;
}

export function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}
