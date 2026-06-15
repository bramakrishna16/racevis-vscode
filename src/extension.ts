import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Status bar item (module-level so we update it from multiple places) ──────
let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  // Status bar: click to run analysis
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.command = "racevis.analyze";
  statusBar.text = "⚡ racevis";
  statusBar.tooltip = "Click to run race detector on current package";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Register the main command
  const cmd = vscode.commands.registerCommand("racevis.analyze", async () => {
    await runAnalysis(context);
  });
  context.subscriptions.push(cmd);
}

export function deactivate() {}

// ── Core analysis flow ────────────────────────────────────────────────────────

async function runAnalysis(context: vscode.ExtensionContext) {
  // 1. Resolve workspace folder
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    vscode.window.showErrorMessage(
      "racevis: No workspace folder open. Open a Go project first."
    );
    return;
  }

  // 2. Check for Go files
  const goFiles = await vscode.workspace.findFiles("**/*.go", "**/vendor/**", 1);
  if (goFiles.length === 0) {
    vscode.window.showErrorMessage(
      "racevis: No Go files found in this workspace."
    );
    return;
  }

  // 3. Read settings
  const config = vscode.workspace.getConfiguration("racevis");
  const binaryPath = config.get<string>("binaryPath") || "racevis";
  const targetSetting = config.get<string>("target") || ".";
  const target =
    targetSetting === "."
      ? workspaceFolder
      : path.resolve(workspaceFolder, targetSetting);

  // 4. Check binary exists
  const resolvedBinary = resolveBinary(binaryPath);
  if (!resolvedBinary) {
    vscode.window.showErrorMessage(
      `racevis: binary not found at '${binaryPath}'. ` +
        `Install with: go install github.com/bramakrishna16/racevis@latest`
    );
    return;
  }

  // 5. Run with progress notification
  statusBar.text = "⚡ racevis $(sync~spin)";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "racevis",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Running race detector..." });

      const jsonOut = path.join(os.tmpdir(), "racevis-out.json");

      try {
        await execBinary(resolvedBinary, [
          "-no-server",
          "-json", jsonOut,
          "-target", target,
        ]);
      } catch (err: any) {
        // racevis exits non-zero when races are found — that's not a failure.
        // Only bail if the JSON wasn't written at all.
        if (!fs.existsSync(jsonOut)) {
          statusBar.text = "⚡ racevis";
          vscode.window.showErrorMessage(`racevis failed: ${err.message}`);
          return;
        }
      }

      progress.report({ message: "Rendering timeline..." });

      // 6. Read JSON
      let timelineJson: string;
      try {
        timelineJson = fs.readFileSync(jsonOut, "utf8");
      } catch (err: any) {
        statusBar.text = "⚡ racevis";
        vscode.window.showErrorMessage(
          `racevis: could not read output JSON: ${err.message}`
        );
        return;
      }

      // 7. Parse to get race count for status bar
      let raceCount = 0;
      try {
        const timeline = JSON.parse(timelineJson);
        raceCount = timeline?.races?.length ?? 0;
      } catch {
        // non-fatal — we still show the webview
      }

      // 8. Load embedded ui/index.html from the racevis binary's report output
      //    We ship ui/index.html inside the extension under media/index.html
      const htmlPath = path.join(context.extensionPath, "media", "index.html");
      if (!fs.existsSync(htmlPath)) {
        statusBar.text = "⚡ racevis";
        vscode.window.showErrorMessage(
          "racevis: media/index.html not found in extension. " +
            "Run 'scripts/copy-ui.sh' to copy it from the racevis repo."
        );
        return;
      }
      let html = fs.readFileSync(htmlPath, "utf8");

      // 9. Inject timeline JSON — mirrors exportHTMLReport in racevis/main.go
      const inlineScript = `<script>\nwindow.__RACEVIS_INLINE_DATA__ = ${timelineJson};\n</script>\n`;
      html = html.replace("<script>", inlineScript + "<script>");

      // 10. Open webview
      const panel = vscode.window.createWebviewPanel(
        "racevis",
        `racevis — ${path.basename(target)}`,
        vscode.ViewColumn.Two,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [], // all resources are inline
        }
      );
      panel.webview.html = html;

      // 11. Update status bar
      if (raceCount === 0) {
        statusBar.text = "⚡ racevis ✓ no races";
        statusBar.backgroundColor = undefined;
      } else {
        statusBar.text = `⚡ racevis 🔴 ${raceCount} race${raceCount === 1 ? "" : "s"}`;
        statusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        );
      }
    }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the racevis binary path. Accepts absolute paths or PATH lookups.
 * Returns null if not found.
 */
function resolveBinary(binaryPath: string): string | null {
  if (path.isAbsolute(binaryPath)) {
    return fs.existsSync(binaryPath) ? binaryPath : null;
  }
  // VS Code Node does not inherit shell PATH on macOS.
  // Augment with common Go binary locations.
  const extraDirs = [
    path.join(os.homedir(), "go", "bin"),
    "/usr/local/go/bin",
    "/opt/homebrew/bin",
  ];
  const pathDirs = [...extraDirs, ...(process.env.PATH || "").split(path.delimiter)];
  for (const dir of pathDirs) {
    const candidate = path.join(dir, binaryPath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Run the racevis binary and return stdout+stderr.
 * Resolves when the process exits (any exit code).
 * Rejects only on spawn failure (binary not found / permission denied).
 */
function execBinary(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const proc = cp.spawn(binary, args, { env: process.env });
    proc.stdout.on("data", (d) => (output += d.toString()));
    proc.stderr.on("data", (d) => (output += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(output));
  });
}
