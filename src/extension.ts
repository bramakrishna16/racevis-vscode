import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Module-level singletons ───────────────────────────────────────────────────
let statusBar: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let activePanel: vscode.WebviewPanel | undefined;
let activeProcess: cp.ChildProcess | undefined;

const ANALYSIS_TIMEOUT_MS = 120_000; // 2 minutes

export function activate(context: vscode.ExtensionContext) {
  // Output channel — persists across runs, visible in Output panel
  outputChannel = vscode.window.createOutputChannel("racevis");
  context.subscriptions.push(outputChannel);

  // Status bar
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.command = "racevis.analyze";
  statusBar.text = "⚡ racevis";
  statusBar.tooltip = "Click to run race detector on current package";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("racevis.analyze", async () => {
      await runAnalysis(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("racevis.showOutput", () => {
      outputChannel.show();
    })
  );
}

export function deactivate() {
  activeProcess?.kill();
}

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
  const goFiles = await vscode.workspace.findFiles(
    "**/*.go",
    "**/vendor/**",
    1
  );
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

  // 4. Resolve binary
  const resolvedBinary = resolveBinary(binaryPath);
  if (!resolvedBinary) {
    vscode.window.showErrorMessage(
      `racevis: binary not found at '${binaryPath}'. ` +
        `Install with: go install github.com/bramakrishna16/racevis@latest`,
      "Show Output"
    ).then((choice) => {
      if (choice === "Show Output") { outputChannel.show(); }
    });
    return;
  }

  // 5. Kill any in-flight analysis
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = undefined;
    outputChannel.appendLine("[racevis] previous analysis cancelled");
  }

  // 6. Use workspace-scoped temp file to avoid collisions
  const safeFolder = workspaceFolder.replace(/[^a-zA-Z0-9]/g, "_");
  const jsonOut = path.join(os.tmpdir(), `racevis-${safeFolder}.json`);

  outputChannel.clear();
  outputChannel.appendLine(`[racevis] analyzing: ${target}`);
  outputChannel.appendLine(`[racevis] binary: ${resolvedBinary}`);

  setStatusRunning();

  // 7. Cancellable progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "racevis",
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: "Running race detector..." });

      token.onCancellationRequested(() => {
        outputChannel.appendLine("[racevis] cancelled by user");
        activeProcess?.kill();
        activeProcess = undefined;
        setStatusIdle();
      });

      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        activeProcess?.kill();
        activeProcess = undefined;
        setStatusIdle();
        vscode.window.showErrorMessage(
          `racevis: analysis timed out after ${ANALYSIS_TIMEOUT_MS / 1000}s. ` +
            `Try -run to target a specific test.`
        );
      }, ANALYSIS_TIMEOUT_MS);

      try {
        await execBinary(resolvedBinary, [
          "-no-server",
          "-json", jsonOut,
          "-target", target,
        ]);
      } catch (err: any) {
        clearTimeout(timeoutHandle);
        if (timedOut || token.isCancellationRequested) { return; }
        // Non-zero exit is normal when races are found — only bail if no JSON
        if (!fs.existsSync(jsonOut)) {
          setStatusIdle();
          outputChannel.appendLine(`[racevis] error: ${err.message}`);
          vscode.window.showErrorMessage(
            `racevis failed. Check Output panel for details.`,
            "Show Output"
          ).then((c) => { if (c === "Show Output") { outputChannel.show(); } });
          return;
        }
      }

      clearTimeout(timeoutHandle);
      if (timedOut || token.isCancellationRequested) { return; }

      progress.report({ message: "Rendering timeline..." });

      // 8. Read JSON
      let timelineJson: string;
      try {
        timelineJson = fs.readFileSync(jsonOut, "utf8");
      } catch (err: any) {
        setStatusIdle();
        outputChannel.appendLine(`[racevis] could not read JSON: ${err.message}`);
        vscode.window.showErrorMessage(
          "racevis: could not read output. Check Output panel.",
          "Show Output"
        ).then((c) => { if (c === "Show Output") { outputChannel.show(); } });
        return;
      }

      // 9. Parse race count — correct field is raceEvents
      let raceCount = 0;
      try {
        const timeline = JSON.parse(timelineJson);
        raceCount = timeline?.raceEvents?.length ?? 0;
        outputChannel.appendLine(
          `[racevis] found ${raceCount} race event(s), ` +
            `${timeline?.lanes?.length ?? 0} goroutine lane(s)`
        );
      } catch {
        outputChannel.appendLine("[racevis] warning: could not parse timeline JSON");
      }

      // 10. Load media/index.html
      const htmlPath = path.join(context.extensionPath, "media", "index.html");
      if (!fs.existsSync(htmlPath)) {
        setStatusIdle();
        vscode.window.showErrorMessage(
          "racevis: media/index.html missing from extension bundle."
        );
        return;
      }
      let html = fs.readFileSync(htmlPath, "utf8");

      // 11. Inject timeline JSON — mirrors exportHTMLReport in racevis/main.go
      const inlineScript = `<script>\nwindow.__RACEVIS_INLINE_DATA__ = ${timelineJson};\n</script>\n`;
      html = html.replace("<script>", inlineScript + "<script>");

      // 12. Reuse existing panel or create new one
      if (activePanel) {
        activePanel.reveal(vscode.ViewColumn.Two, true);
        activePanel.webview.html = html;
        activePanel.title = `racevis — ${path.basename(target)}`;
      } else {
        activePanel = vscode.window.createWebviewPanel(
          "racevis",
          `racevis — ${path.basename(target)}`,
          { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [],
          }
        );
        activePanel.onDidDispose(() => {
          activePanel = undefined;
        });
        activePanel.webview.html = html;
      }

      // 13. Update status bar
      setStatusResult(raceCount);
    }
  );
}

// ── Status bar helpers ────────────────────────────────────────────────────────

function setStatusRunning() {
  statusBar.text = "⚡ racevis $(sync~spin)";
  statusBar.backgroundColor = undefined;
  statusBar.tooltip = "Race detector running...";
}

function setStatusIdle() {
  statusBar.text = "⚡ racevis";
  statusBar.backgroundColor = undefined;
  statusBar.tooltip = "Click to run race detector on current package";
}

function setStatusResult(raceCount: number) {
  if (raceCount === 0) {
    statusBar.text = "⚡ racevis ✓ no races";
    statusBar.backgroundColor = undefined;
    statusBar.tooltip = "No races found. Click to re-run.";
  } else {
    statusBar.text = `⚡ racevis 🔴 ${raceCount} race${raceCount === 1 ? "" : "s"}`;
    statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    statusBar.tooltip = `${raceCount} data race(s) found. Click to re-run.`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveBinary(binaryPath: string): string | null {
  if (path.isAbsolute(binaryPath)) {
    return fs.existsSync(binaryPath) ? binaryPath : null;
  }
  // VS Code's Node process doesn't inherit shell PATH on macOS.
  // Prepend common Go binary locations.
  const extraDirs = [
    path.join(os.homedir(), "go", "bin"),
    "/usr/local/go/bin",
    "/opt/homebrew/bin",
  ];
  const pathDirs = [
    ...extraDirs,
    ...(process.env.PATH || "").split(path.delimiter),
  ];
  for (const dir of pathDirs) {
    const candidate = path.join(dir, binaryPath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function execBinary(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const proc = cp.spawn(binary, args, { env: process.env });
    activeProcess = proc;
    proc.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      output += s;
      outputChannel.append(s);
    });
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      output += s;
      outputChannel.append(s);
    });
    proc.on("error", (err) => {
      activeProcess = undefined;
      reject(err);
    });
    proc.on("close", () => {
      activeProcess = undefined;
      resolve(output);
    });
  });
}
