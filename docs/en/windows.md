# Piagent on Windows

[Tiếng Việt](../vi/windows.md)

Piagent runs on Windows in two ways:

| Mode | Where it runs | What it needs |
|---|---|---|
| Personal (your own AI account) | On Windows itself, or in WSL2 | Node 24, Git for Windows (for the `bash` tool) |
| Company (models through Agent Studio) | In **WSL2** (Ubuntu) | WSL2, bubblewrap, Agent Watch for Windows |

Company mode needs an operating-system sandbox around every command the agent runs. On macOS that is Seatbelt; on Linux and WSL2 it is bubblewrap. Windows has no equivalent sandbox an agent can use yet, so company mode runs in WSL2.

## Company mode in WSL2

1. Install WSL2 with Ubuntu (PowerShell): `wsl --install -d Ubuntu`.
2. In Ubuntu:

   ```bash
   sudo apt-get update && sudo apt-get install -y bubblewrap git ripgrep fd-find build-essential curl
   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 24
   npm install -g --ignore-scripts @piagent/platform
   piagent-update
   piagent --help
   ```

   `piagent --help` runs once so Piagent records where it is installed, for Agent Watch.

3. Install Agent Watch for Windows (PowerShell), paste the connection code your admin sent, choose **Kết nối** (Connect), then **Kết nối Piagent trong WSL** (Connect Piagent in WSL):

   ```powershell
   irm https://raw.githubusercontent.com/Vt-mmm/agentwatch/main/windows/install.ps1 | iex
   ```

   Full guide: [Agent Watch for Windows](https://github.com/Vt-mmm/agentwatch/blob/main/windows/README.md). After each Piagent update, choose **Kết nối Piagent trong WSL** again (Agent Watch does it when it starts).
4. In Ubuntu: `piagent dashboard` (opens in the Windows browser) or `piagent studio --project ~/projects/shop`.

Check the machine with `piagent studio --doctor`.

### The sandbox on Linux and WSL2

It keeps the macOS sandbox's promises, built from bubblewrap mounts:

- The project is writable; the project's package cache is writable (`~/.cache/piagent/sandbox`); there is a private temporary folder.
- Other folders in the home folder are readable for reference when you point to them, read-only; hidden entries of the home folder (`~/.ssh`, `~/.bashrc`, tool settings…) are not in the sandbox at all.
- Credential files (`.env`, `.npmrc`, `credentials`, `auth.json`) read as empty.
- A command without network approval runs in its own network namespace: it reaches only the servers it starts itself (no internet, no proxy, no service running on the machine). Start a test server and run the tests in the same command; a database already running on the machine needs `run_with_network`.
- Processes a command leaves behind end with that command.
- Windows programs cannot be started from inside the sandbox.

Unlike macOS: Windows folders (`/mnt/c/...`) are not readable for reference from a project in WSL; a project on `/mnt/c` works but is slower than one on the WSL disk.

## Personal mode on Windows itself

Install Node 24 and [Git for Windows](https://git-scm.com/download/win), then in PowerShell:

```powershell
npm install -g --ignore-scripts @piagent/platform
piagent dashboard
```

Piagent's guard checks Windows-style paths: another drive (`D:\…`), `AppData` and hidden entries of the home folder are not project paths.
