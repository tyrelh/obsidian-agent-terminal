import {
  FileSystemAdapter,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf
} from "obsidian";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const VIEW_TYPE_AGENT_TERMINAL = "agent-terminal:view";

type AgentProfile = "codex" | "claude" | "custom";

interface AgentTerminalSettings {
  defaultProfile: AgentProfile;
  codexCommand: string;
  claudeCommand: string;
  customCommand: string;
  workingDirectory: string;
  shellPath: string;
}

const DEFAULT_SETTINGS: AgentTerminalSettings = {
  defaultProfile: "codex",
  codexCommand: "codex --no-alt-screen",
  claudeCommand: "claude",
  customCommand: "",
  workingDirectory: "",
  shellPath: "/bin/zsh"
};

const PROFILE_LABELS: Record<AgentProfile, string> = {
  codex: "Codex CLI",
  claude: "Claude Code",
  custom: "Custom"
};

function isProcessAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (child.exitCode !== null || child.signalCode !== null) {
    return false;
  }

  if (child.pid == null) {
    return false;
  }

  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

class AgentTerminalView extends ItemView {
  plugin: AgentTerminalPlugin;
  terminal: Terminal | null = null;
  fitAddon: FitAddon | null = null;
  process: ChildProcessWithoutNullStreams | null = null;
  processControlStream: NodeJS.WritableStream | null = null;
  profile: AgentProfile;
  profileSelectEl!: HTMLSelectElement;
  commandInputEl!: HTMLInputElement;
  statusEl!: HTMLSpanElement;
  terminalHostEl!: HTMLDivElement;
  resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AgentTerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.profile = plugin.settings.defaultProfile;
  }

  getViewType(): string {
    return VIEW_TYPE_AGENT_TERMINAL;
  }

  getDisplayText(): string {
    return "Agent Terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("agent-terminal-root");
    this.buildToolbar();
    this.buildTerminal();
    this.initTerminal();
    const initialProfile = this.plugin.consumePendingInitialProfile() ?? this.plugin.settings.defaultProfile;
    await this.startProfile(initialProfile);
  }

  async onClose(): Promise<void> {
    this.stopProcess(false);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }

  refreshFromSettings(): void {
    if (this.profileSelectEl) {
      this.profileSelectEl.value = this.plugin.settings.defaultProfile;
    }
    this.applyProfile(this.plugin.settings.defaultProfile);
  }

  async startProfile(profile: AgentProfile): Promise<void> {
    this.applyProfile(profile);
    await this.startCommand(this.commandInputEl.value.trim());
  }

  private buildToolbar(): void {
    const toolbar = this.contentEl.createDiv({ cls: "agent-terminal-toolbar" });

    this.profileSelectEl = toolbar.createEl("select", { cls: "agent-terminal-profile" });
    (Object.keys(PROFILE_LABELS) as AgentProfile[]).forEach((profile) => {
      this.profileSelectEl.createEl("option", {
        text: PROFILE_LABELS[profile],
        value: profile
      });
    });
    this.profileSelectEl.value = this.profile;
    this.profileSelectEl.addEventListener("change", () => {
      this.applyProfile(this.profileSelectEl.value as AgentProfile);
    });

    this.commandInputEl = toolbar.createEl("input", {
      cls: "agent-terminal-command",
      type: "text",
      placeholder: "Command to run..."
    });
    this.commandInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.startCommand(this.commandInputEl.value.trim());
      }
    });

    const runButton = toolbar.createEl("button", { text: "Run" });
    runButton.addEventListener("click", () => {
      void this.startCommand(this.commandInputEl.value.trim());
    });

    const stopButton = toolbar.createEl("button", { text: "Stop" });
    stopButton.addEventListener("click", () => {
      this.stopProcess();
    });

    const clearButton = toolbar.createEl("button", { text: "Clear" });
    clearButton.addEventListener("click", () => {
      this.terminal?.clear();
      this.terminal?.write("\x1b[90mAgent Terminal ready.\x1b[0m\r\n");
    });

    this.statusEl = toolbar.createEl("span", { cls: "agent-terminal-status", text: "idle" });
  }

  private buildTerminal(): void {
    this.terminalHostEl = this.contentEl.createDiv({ cls: "agent-terminal-output" });
  }

  private initTerminal(): void {
    this.terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: this.resolveObsidianMonospaceFont(),
      fontSize: 13,
      scrollback: 8000,
      theme: this.resolveObsidianTerminalTheme()
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.terminalHostEl);
    this.fitAddon.fit();
    this.terminal.focus();
    this.terminal.write("\x1b[90mAgent Terminal ready.\x1b[0m\r\n");

    this.terminal.onData((data) => {
      this.process?.stdin.write(data);
    });
    this.terminal.onBinary((data) => {
      this.process?.stdin.write(Buffer.from(data, "binary"));
    });

    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon?.fit();
      this.sendResize();
    });
    this.resizeObserver.observe(this.terminalHostEl);

    this.registerEvent(this.app.workspace.on("css-change", () => {
      const terminal = this.terminal;
      if (!terminal) {
        return;
      }
      terminal.options.fontFamily = this.resolveObsidianMonospaceFont();
      terminal.options.theme = this.resolveObsidianTerminalTheme();
      this.fitAddon?.fit();
      this.sendResize();
    }));
  }

  private resolveObsidianMonospaceFont(): string {
    const css = window.getComputedStyle(document.body);
    const byVaultSetting = css.getPropertyValue("--font-monospace").trim();
    const byTheme = css.getPropertyValue("--font-monospace-theme").trim();
    const fallback = "Menlo, Monaco, 'Courier New', monospace";

    if (byVaultSetting) {
      return byVaultSetting;
    }
    if (byTheme) {
      return byTheme;
    }
    return fallback;
  }

  private resolveObsidianTerminalTheme(): Terminal["options"]["theme"] {
    const css = window.getComputedStyle(document.body);
    const pick = (fallback: string, ...names: string[]): string => {
      for (const name of names) {
        const value = css.getPropertyValue(name).trim();
        if (value) {
          return value;
        }
      }
      return fallback;
    };

    const foreground = pick("#d7dce2", "--text-normal");
    const background = pick("#1d2128", "--background-primary");
    const cursor = pick(foreground, "--text-normal", "--text-accent");
    const selectionBackground = pick("rgba(127, 127, 127, 0.3)", "--background-modifier-hover");

    return {
      foreground,
      background,
      cursor,
      cursorAccent: background,
      selectionBackground,
      black: pick("#2b303b", "--text-faint", "--background-modifier-border"),
      red: pick("#e06c75", "--color-red"),
      green: pick("#98c379", "--color-green"),
      yellow: pick("#e5c07b", "--color-yellow"),
      blue: pick("#61afef", "--color-blue"),
      magenta: pick("#c678dd", "--color-purple"),
      cyan: pick("#56b6c2", "--color-cyan"),
      white: pick("#d7dce2", "--text-normal"),
      brightBlack: pick("#5c6370", "--text-muted"),
      brightRed: pick("#e06c75", "--color-red"),
      brightGreen: pick("#98c379", "--color-green"),
      brightYellow: pick("#e5c07b", "--color-yellow"),
      brightBlue: pick("#61afef", "--color-blue"),
      brightMagenta: pick("#c678dd", "--color-purple"),
      brightCyan: pick("#56b6c2", "--color-cyan"),
      brightWhite: pick("#ffffff", "--text-normal")
    };
  }

  private applyProfile(profile: AgentProfile): void {
    this.profile = profile;
    if (this.profileSelectEl) {
      this.profileSelectEl.value = profile;
    }
    this.commandInputEl.value = this.commandForProfile(profile);
  }

  private commandForProfile(profile: AgentProfile): string {
    const settings = this.plugin.settings;
    if (profile === "codex") {
      return settings.codexCommand;
    }
    if (profile === "claude") {
      return settings.claudeCommand;
    }
    return settings.customCommand;
  }

  private async startCommand(command: string): Promise<void> {
    if (!command) {
      new Notice("Agent Terminal: command is empty.");
      return;
    }

    this.stopProcess(false);

    const cwd = this.plugin.resolveWorkingDirectory();
    if (!cwd) {
      new Notice("Agent Terminal: could not resolve working directory.");
      return;
    }

    const settings = this.plugin.settings;
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    };

    let executable: string;
    let args: string[];
    let stdio: Array<"pipe"> = ["pipe", "pipe", "pipe"];

    if (process.platform === "win32") {
      executable = "cmd.exe";
      args = ["/d", "/s", "/c", command];
    } else {
      const pluginDir = this.plugin.manifest.dir;
      if (!pluginDir) {
        new Notice("Agent Terminal: plugin directory is not available.");
        return;
      }

      executable = "python3";
      const bridgePath = join(pluginDir, "scripts", "pty_bridge.py");
      const rows = this.terminal?.rows ?? 24;
      const cols = this.terminal?.cols ?? 80;
      args = [
        bridgePath,
        "--shell",
        settings.shellPath,
        "--cwd",
        cwd,
        "--rows",
        String(rows),
        "--cols",
        String(cols),
        "--command",
        command
      ];
      stdio = ["pipe", "pipe", "pipe", "pipe"];
    }

    try {
      const child = spawn(executable, args, {
        cwd,
        env,
        stdio
      });
      this.plugin.trackManagedProcess(child);
      this.process = child;
      this.processControlStream = null;

      if (process.platform !== "win32") {
        const control = child.stdio[3];
        if (control && typeof (control as NodeJS.WritableStream).write === "function") {
          this.processControlStream = control as NodeJS.WritableStream;
        }
      }

      this.statusEl.setText(`running in ${cwd}`);
      this.terminal?.write(`\r\n\x1b[36m$ ${command}\x1b[0m\r\n`);

      child.stdout.on("data", (chunk: Buffer | string) => {
        this.terminal?.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        this.terminal?.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });

      child.on("error", (error) => {
        this.terminal?.write(`\r\n\x1b[31m[spawn error] ${error.message}\x1b[0m\r\n`);
        this.statusEl.setText("error");
        this.process = null;
        this.processControlStream = null;
      });
      child.on("exit", (code, signal) => {
        const details = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
        this.terminal?.write(`\r\n\x1b[90m[process exited: ${details}]\x1b[0m\r\n`);
        this.statusEl.setText("idle");
        this.processControlStream = null;
        if (this.process === child) {
          this.process = null;
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.terminal?.write(`\r\n\x1b[31m[start error] ${message}\x1b[0m\r\n`);
      this.statusEl.setText("error");
    }
  }

  private stopProcess(showNotice = true): void {
    const current = this.process;
    if (!current) {
      return;
    }

    this.process = null;
    this.processControlStream = null;
    try {
      this.plugin.terminateManagedProcess(current);
      this.terminal?.write("\r\n\x1b[90m[stopping process]\x1b[0m\r\n");
      this.statusEl.setText("idle");
      if (showNotice) {
        new Notice("Agent Terminal: process stopped.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.terminal?.write(`\r\n\x1b[31m[stop error] ${message}\x1b[0m\r\n`);
    }
  }

  private sendResize(): void {
    const terminal = this.terminal;
    if (!terminal || !this.processControlStream) {
      return;
    }

    const rows = terminal.rows;
    const cols = terminal.cols;
    if (rows <= 0 || cols <= 0) {
      return;
    }

    this.processControlStream.write(`RESIZE ${rows} ${cols}\n`);
  }
}

class AgentTerminalSettingTab extends PluginSettingTab {
  plugin: AgentTerminalPlugin;

  constructor(plugin: AgentTerminalPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default profile")
      .setDesc("Preselect a profile when opening Agent Terminal.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("codex", "Codex CLI")
          .addOption("claude", "Claude Code")
          .addOption("custom", "Custom")
          .setValue(this.plugin.settings.defaultProfile)
          .onChange(async (value) => {
            this.plugin.settings.defaultProfile = value as AgentProfile;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Codex command")
      .setDesc("Command used by the Codex profile.")
      .addText((text) => {
        text
          .setPlaceholder("codex --no-alt-screen")
          .setValue(this.plugin.settings.codexCommand)
          .onChange(async (value) => {
            this.plugin.settings.codexCommand = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Claude command")
      .setDesc("Command used by the Claude profile.")
      .addText((text) => {
        text
          .setPlaceholder("claude")
          .setValue(this.plugin.settings.claudeCommand)
          .onChange(async (value) => {
            this.plugin.settings.claudeCommand = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Custom command")
      .setDesc("Command used by the Custom profile.")
      .addText((text) => {
        text
          .setPlaceholder("your-command-here")
          .setValue(this.plugin.settings.customCommand)
          .onChange(async (value) => {
            this.plugin.settings.customCommand = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("Leave empty to use your vault root directory.")
      .addText((text) => {
        text
          .setPlaceholder("(vault root)")
          .setValue(this.plugin.settings.workingDirectory)
          .onChange(async (value) => {
            this.plugin.settings.workingDirectory = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Shell path")
      .setDesc("Used on macOS/Linux to launch commands in a login shell.")
      .addText((text) => {
        text
          .setPlaceholder("/bin/zsh")
          .setValue(this.plugin.settings.shellPath)
          .onChange(async (value) => {
            this.plugin.settings.shellPath = value.trim() || "/bin/zsh";
            await this.plugin.saveSettings();
          });
      });
  }
}

export default class AgentTerminalPlugin extends Plugin {
  settings: AgentTerminalSettings = DEFAULT_SETTINGS;
  private pendingInitialProfile: AgentProfile | null = null;
  private activeProcesses = new Set<ChildProcessWithoutNullStreams>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_AGENT_TERMINAL, (leaf) => new AgentTerminalView(leaf, this));
    this.addSettingTab(new AgentTerminalSettingTab(this));

    this.addRibbonIcon("terminal", "Open Agent Terminal", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-agent-terminal",
      name: "Open Agent Terminal",
      callback: () => {
        void this.activateView();
      }
    });

    this.addCommand({
      id: "run-codex-profile",
      name: "Agent Terminal: Run Codex profile",
      callback: () => {
        void this.activateView("codex");
      }
    });

    this.addCommand({
      id: "run-claude-profile",
      name: "Agent Terminal: Run Claude profile",
      callback: () => {
        void this.activateView("claude");
      }
    });

    this.registerDomEvent(window, "beforeunload", () => {
      this.stopAllManagedProcesses();
    });
    this.registerDomEvent(window, "pagehide", () => {
      this.stopAllManagedProcesses();
    });
    this.register(() => {
      this.stopAllManagedProcesses();
    });
  }

  onunload(): void {
    this.stopAllManagedProcesses();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AGENT_TERMINAL);
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_TERMINAL).forEach((leaf) => {
      if (leaf.view instanceof AgentTerminalView) {
        leaf.view.refreshFromSettings();
      }
    });
  }

  resolveWorkingDirectory(): string | null {
    if (this.settings.workingDirectory) {
      return this.settings.workingDirectory;
    }

    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }

    return null;
  }

  consumePendingInitialProfile(): AgentProfile | null {
    const profile = this.pendingInitialProfile;
    this.pendingInitialProfile = null;
    return profile;
  }

  trackManagedProcess(child: ChildProcessWithoutNullStreams): void {
    this.activeProcesses.add(child);
    const cleanup = () => {
      this.activeProcesses.delete(child);
    };
    child.once("exit", cleanup);
    child.once("error", cleanup);
  }

  terminateManagedProcess(child: ChildProcessWithoutNullStreams): void {
    this.activeProcesses.delete(child);

    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }

    window.setTimeout(() => {
      if (!isProcessAlive(child)) {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // No-op: process may have exited between liveness check and kill.
      }
    }, 1200);
  }

  stopAllManagedProcesses(): void {
    for (const child of [...this.activeProcesses]) {
      this.terminateManagedProcess(child);
    }
  }

  private async activateView(profileToStart?: AgentProfile): Promise<void> {
    let createdLeaf = false;
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_AGENT_TERMINAL
    )[0] ?? null;

    if (!leaf) {
      createdLeaf = true;
      this.pendingInitialProfile = profileToStart ?? null;
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("Agent Terminal: unable to open a workspace leaf.");
        this.pendingInitialProfile = null;
        return;
      }
      await leaf.setViewState({
        type: VIEW_TYPE_AGENT_TERMINAL,
        active: true
      });
    }

    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!createdLeaf && profileToStart && view instanceof AgentTerminalView) {
      await view.startProfile(profileToStart);
    }
  }
}
