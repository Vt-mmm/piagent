// Page order, titles and leads for the docs site, in both languages.
//
// Order here is the order in the sidebar, and it is also the order of the
// previous/next links at the foot of each page. Leads are one or two short
// sentences: they become the page subtitle, the meta description and the text
// the search palette matches.

const NAV = [
  {
    group: "Bắt đầu",
    pages: [
      {
        slug: "index",
        href: "/",
        icon: "home",
        nav: "Tổng quan",
        title: "Pi Agent Platform",
        lead: "Coding agent cho cả team: guard kiểm tra mọi tool call, Harness của team tự chạy check và review, một dashboard cho Terminal và trình duyệt."
      },
      {
        slug: "ecosystem",
        icon: "network",
        nav: "Hệ sinh thái",
        title: "Piagent, Agent Watch và Agent Studio",
        lead: "Phần nào chạy trên máy bạn, phần nào ở máy chủ công ty, và khi nào dùng model cá nhân hay model của công ty."
      },
      {
        slug: "quickstart",
        icon: "rocket",
        nav: "Cài đặt",
        title: "Cài đặt và chạy lượt đầu tiên",
        lead: "Hai lệnh để cài. Mở repo, chọn profile và quyền, rồi nói việc bằng lời thường."
      },
      {
        slug: "windows",
        icon: "windows",
        nav: "Cài trên Windows",
        title: "Cài trên Windows bằng một lệnh",
        lead: "Một lệnh PowerShell cài WSL2, Ubuntu, Piagent và Agent Watch, nối key công ty và thêm Piagent vào Start menu. Chạy lại để cập nhật."
      },
      {
        slug: "update",
        icon: "refresh",
        nav: "Cập nhật và gỡ",
        title: "Cập nhật, rollback và gỡ cài đặt",
        lead: "Một lệnh để lên bản mới, dashboard và Terminal tự báo khi có bản mới. Rollback và gỡ cài đặt đều có bước xem trước."
      },
      {
        slug: "whats-new",
        icon: "sparkles",
        nav: "Changelog",
        title: "Changelog",
        lead: "Mỗi bản phát hành: thay đổi gì, cần bản nào của Studio hay Agent Watch. Bản mới nhất ở trên cùng."
      },
      {
        slug: "scope",
        icon: "target",
        nav: "Phạm vi platform",
        title: "Platform nhận phần nào về mình",
        lead: "Agent nào cũng có cơ chế governance riêng. Platform này đóng gói một cách vận hành cụ thể trên Pi để mọi repo dùng lại."
      }
    ]
  },
  {
    group: "Sử dụng",
    pages: [
      {
        slug: "profiles",
        icon: "sliders",
        nav: "Project profile",
        title: "Chọn đúng profile cho repo",
        lead: "Profile quyết định protected path, verify command và capability mà repo được cấp; ghi vào .pi/piagent-profile.json và lock tương ứng."
      },
      {
        slug: "permissions",
        icon: "key",
        nav: "Permission modes",
        title: "Đổi quyền theo task bằng một lệnh",
        lead: "Permission mode chỉ áp dụng cho session hiện tại. Đổi mode không sửa project profile."
      },
      {
        slug: "commands",
        icon: "terminal",
        nav: "Command catalog",
        title: "Command ngắn, hành vi rõ",
        lead: "Slash command gói sẵn policy và flow; một inspector cho diff, command, safety và context."
      },
      {
        slug: "workflows",
        icon: "branch",
        nav: "Workflows",
        title: "Làm việc hằng ngày",
        lead: "Không có launcher workflow: nói việc bằng lời thường. Command xem thêm chỉ quan sát, không mở lượt model."
      }
    ]
  },
  {
    group: "MCP",
    pages: [
      {
        slug: "mcp",
        icon: "plug",
        nav: "Tổng quan MCP",
        title: "MCP trong Pi Agent Platform",
        lead: "Platform cài pi-mcp-adapter để dùng MCP tiết kiệm token, và quản lý server trên bốn lớp cấu hình."
      },
      {
        slug: "mcp-servers",
        icon: "server",
        nav: "Quản lý server",
        title: "Thêm, xem và gỡ MCP server",
        lead: "piagent-mcp có đủ add, remove, get, list, enable, disable trên cả bốn scope."
      },
      {
        slug: "mcp-auth",
        icon: "lock",
        nav: "Auth và readiness",
        title: "Đăng nhập và trạng thái sẵn sàng",
        lead: "Platform không giữ token và không tự chạy OAuth. Nó từ chối ghi secret vào config và cho biết server nào thật sự gọi được."
      },
      {
        slug: "mcp-approval",
        icon: "shield-check",
        nav: "Approval gate",
        title: "Server đến từ repo phải được duyệt",
        lead: "Clone một repo lạ không cho tác giả repo đó chạy process trên máy bạn. Quyết định lưu ngoài repo và pin theo digest."
      }
    ]
  },
  {
    group: "Vận hành",
    pages: [
      {
        slug: "security",
        icon: "shield",
        nav: "Security model",
        title: "Lớp policy, không phải OS sandbox",
        lead: "Fail-closed trong bề mặt tool được kiểm soát: lock sai, profile sai hay thiếu quyền thì chặn, không đoán."
      },
      {
        slug: "architecture",
        icon: "layers",
        nav: "Kiến trúc",
        title: "Kiến trúc repo",
        lead: "Core chỉ giữ policy, prompt, guard, skill và script dùng lại được; business logic ở lại project của nó."
      },
      {
        slug: "context-engine",
        icon: "cpu",
        nav: "Context Engine",
        title: "Ít context hơn, giữ nguyên chất lượng",
        lead: "Index local, retrieval có xếp hạng, tool nạp theo task, compaction theo ngữ nghĩa và telemetry minh bạch."
      },
      {
        slug: "benchmark",
        icon: "chart",
        nav: "Benchmark",
        title: "Bằng chứng chất lượng và hiệu suất",
        lead: "So Piagent với codex-cli trên cùng model, cùng thinking: 18 nhóm bài, 108 session chấm tự động."
      },
      {
        slug: "runtime",
        icon: "wrench",
        nav: "Runtime tools",
        title: "Terminal command cho người vận hành",
        lead: "Command chạy ngoài slash command: setup, doctor, benchmark, capability và MCP."
      },
      {
        slug: "team",
        icon: "users",
        nav: "Dùng cho team",
        title: "Một chuẩn vận hành cho cả team",
        lead: "Mỗi repo link package, chọn profile phù hợp và giữ tài liệu riêng ở repo của dự án đó."
      }
    ]
  }
];

const EN_GROUPS = {
  "Bắt đầu": "Get started",
  "Sử dụng": "Build",
  MCP: "MCP",
  "Vận hành": "Operate"
};

const EN_PAGE_COPY = {
  index: {
    nav: "Overview",
    title: "Pi Agent Platform",
    lead: "A coding agent for the whole team: a guard checks every tool call, the team's Harness runs checks and review, one dashboard for Terminal and the browser."
  },
  ecosystem: {
    nav: "Ecosystem",
    title: "Piagent, Agent Watch and Agent Studio",
    lead: "What runs on your machine, what runs on the company server, and when to use your own model or the company's."
  },
  quickstart: {
    nav: "Install",
    title: "Install and run your first turn",
    lead: "Two commands to install. Open a repository, pick its profile and permissions, then ask in plain language."
  },
  windows: {
    nav: "Windows",
    title: "Install on Windows with one command",
    lead: "One PowerShell command installs WSL2, Ubuntu, Piagent and Agent Watch, binds the company key and adds Piagent to the Start menu. Run it again to update."
  },
  update: {
    nav: "Update & uninstall",
    title: "Update, roll back and uninstall",
    lead: "One command moves to a new release, and the dashboard and Terminal tell you when one is out. Rollback and uninstall both preview first."
  },
  "whats-new": {
    nav: "Changelog",
    title: "Changelog",
    lead: "Every release: what changed and which Studio or Agent Watch it needs. Newest first."
  },
  scope: {
    nav: "Platform scope",
    title: "What the platform owns",
    lead: "Every agent has governance primitives. This platform packages one repeatable operating model on Pi for every repository."
  },
  profiles: {
    nav: "Project profiles",
    title: "Choose the right profile",
    lead: "A profile sets protected paths, verification commands and the capabilities a repository is granted."
  },
  permissions: {
    nav: "Permission modes",
    title: "Change permissions per task",
    lead: "Permission modes apply to the current session only. Changing one does not modify the project profile."
  },
  commands: {
    nav: "Command catalog",
    title: "Short commands, predictable behaviour",
    lead: "Slash commands package policy and flow, with one inspector for diffs, commands, safety and context."
  },
  workflows: {
    nav: "Workflows",
    title: "Day-to-day work",
    lead: "No workflow launchers: say what you need in plain language. Inspection commands only observe and never start a model turn."
  },
  mcp: {
    nav: "MCP overview",
    title: "MCP in Pi Agent Platform",
    lead: "The platform installs pi-mcp-adapter for token-efficient MCP access and manages servers across four configuration layers."
  },
  "mcp-servers": {
    nav: "Server management",
    title: "Add, inspect and remove MCP servers",
    lead: "piagent-mcp provides add, remove, get, list, enable and disable across all four scopes."
  },
  "mcp-auth": {
    nav: "Authentication",
    title: "Authentication and readiness",
    lead: "The platform stores no tokens and runs no OAuth. It rejects secrets in configuration and reports which servers are actually ready."
  },
  "mcp-approval": {
    nav: "Approval gate",
    title: "Repository servers require approval",
    lead: "Cloning an untrusted repository must not give its author a process on your machine. Decisions live outside the repository, pinned by digest."
  },
  security: {
    nav: "Security model",
    title: "Policy enforcement, not an OS sandbox",
    lead: "Controlled tool surfaces fail closed when profiles, integrity locks or permissions are invalid."
  },
  architecture: {
    nav: "Architecture",
    title: "Repository architecture",
    lead: "Core holds reusable policy and runtime infrastructure; business logic stays in the project that owns it."
  },
  "context-engine": {
    nav: "Context Engine",
    title: "Less context, same model quality",
    lead: "Local indexing, ranked retrieval, task-driven tool loading, semantic compaction and transparent telemetry."
  },
  benchmark: {
    nav: "Benchmark",
    title: "Quality and efficiency evidence",
    lead: "Piagent against codex-cli on the same model and thinking level: 18 task families, 108 automatically graded sessions."
  },
  runtime: {
    nav: "Runtime tools",
    title: "Terminal commands for operators",
    lead: "Commands that run outside Pi: setup, updates, doctor, benchmarks, capabilities and MCP."
  },
  team: {
    nav: "Team usage",
    title: "One operating standard for the team",
    lead: "Each repository links the package, selects a fitting profile and keeps project documentation in its own repository."
  }
};

const NAV_BY_LOCALE = {
  vi: NAV,
  en: NAV.map((section) => ({
    group: EN_GROUPS[section.group] ?? section.group,
    pages: section.pages.map((page) => ({ ...page, ...EN_PAGE_COPY[page.slug] }))
  }))
};

export { NAV, NAV_BY_LOCALE };
