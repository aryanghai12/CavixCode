// Cavix VS Code extension — pre-PR local review. It collects the open workspace
// files, posts them to the local Cavix review server (@cavix/ide
// createLocalReviewServer), and renders the results as native diagnostics. The
// SAME engine runs here as in the PR pipeline, so what you see locally is what
// Cavix would post.
import * as vscode from "vscode";

interface CavixDiagnostic {
  path: string;
  line: number;
  endLine?: number;
  severity: "error" | "warning" | "information" | "hint";
  source: string;
  ruleId?: string;
  message: string;
}

const SEVERITY: Record<CavixDiagnostic["severity"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

export function activate(context: vscode.ExtensionContext) {
  const collection = vscode.languages.createDiagnosticCollection("cavix");
  context.subscriptions.push(collection);

  const review = async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const uris = await vscode.workspace.findFiles("**/*.{js,ts,tsx,py,go,c,cpp,java,cs,cob,pls,sql,tf,yaml}", "**/node_modules/**", 500);
    const files = await Promise.all(
      uris.map(async (u) => ({ path: vscode.workspace.asRelativePath(u), content: (await vscode.workspace.fs.readFile(u)).toString() })),
    );
    const base = vscode.workspace.getConfiguration("cavix").get<string>("serverUrl", "http://127.0.0.1:7077");
    const res = await fetch(`${base}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }) });
    const { diagnostics, summary } = (await res.json()) as { diagnostics: CavixDiagnostic[]; summary: string };

    collection.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of diagnostics) {
      const line = Math.max(0, d.line - 1);
      const range = new vscode.Range(line, 0, (d.endLine ?? d.line) - 1, 200);
      const diag = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity]);
      diag.source = d.source;
      diag.code = d.ruleId;
      const abs = vscode.Uri.joinPath(folder.uri, d.path).toString();
      (byFile.get(abs) ?? byFile.set(abs, []).get(abs)!).push(diag);
    }
    for (const [uri, diags] of byFile) collection.set(vscode.Uri.parse(uri), diags);
    vscode.window.setStatusBarMessage(`🔬 ${summary}`, 5000);
  };

  context.subscriptions.push(vscode.commands.registerCommand("cavix.reviewWorkingTree", review));
  if (vscode.workspace.getConfiguration("cavix").get<boolean>("reviewOnSave", true)) {
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => review()));
  }
}

export function deactivate() {}
