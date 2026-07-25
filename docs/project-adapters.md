# Project adapters

## Mục tiêu

Adapter mô tả project cho Pi core. Core không biết domain/project cụ thể trừ khi profile khai báo.

## Profile schema hiện tại

```json
{
  "schemaVersion": 1,
  "projectId": "my-project",
  "displayName": "My Project",
  "mode": "web-frontend",
  "permissionProfile": "workspace-write",
  "rootMarkers": ["AGENTS.md", "package.json"],
  "protectedPaths": [".git/**", "**/auth.json"],
  "shellProtectedPaths": [".git/**", "**/auth.json"],
  "readOnlyPaths": ["backend/**"],
  "requiredContext": ["AGENTS.md", "docs/architecture.md"],
  "taskModes": {
    "readOnly": { "tools": ["read", "grep", "find", "ls"] },
    "sourceWrite": { "requiresPlan": true, "requiresVerify": true }
  },
  "verifyCommands": {
    "docsOnly": ["test -s README.md"],
    "source": ["npm test"]
  },
  "mcpCapabilities": [
    "filesystem-readonly",
    "filesystem-write",
    "shell",
    "github",
    "memory"
  ],
  "techStack": {
    "provider": "context7",
    "manifest": ".pi/tech-stack.json",
    "contextDir": ".pi/tech-context",
    "roles": {
      "frontend": ["nextjs"],
      "backend": ["nestjs"],
      "database": ["prisma"]
    }
  },
  "contextIndex": {
    "enabled": true,
    "path": ".pi/context-index.json",
    "writePolicy": "onboarding-record",
    "requireCitations": true,
    "maxNodes": 120,
    "maxEdges": 240,
    "includeTechStack": true,
    "includeMemoryPointers": true
  },
  "runtimePolicy": {
    "execPolicy": "enforce",
    "contextBudget": "enforce",
    "toolRegistry": "advisory",
    "finalGate": "enforce"
  }
}
```

Path policy fields have distinct meanings:

- `protectedPaths`: block read/write path-tool access and protect these paths from shell parsing when `shellProtectedPaths` is omitted.
- `readOnlyPaths`: allow `read`/`grep`/`find`/`ls`, but block `write`/`edit` and shell access.
- `shellProtectedPaths`: block shell access only. Do not rely on this field to block write/edit; `profile-doctor` and `team-doctor` warn when a path is present only here.

## Built-in adapters

| Profile | Dùng cho | Verify mặc định |
|---|---|---|
| `generic` | Repo chưa có chuẩn riêng | README check hoặc message yêu cầu cấu hình verify |
| `web-frontend` | Next/React/Vite frontend | type-check, lint, test, e2e nếu project khai báo |
| `backend-api` | Node/Java/Python API | npm/maven/gradle/pytest tùy marker |
| `be-readonly-fe` | BE là source of truth nhưng chỉ scout/read-only; FE là write target | FE type-check/lint/test/e2e theo layout phổ biến |
| `fullstack` | Repo có FE + BE/monorepo | type-check, lint, test, e2e nếu có |
| `node-typescript` | Node/TS library/tooling | npm type-check/lint/test nếu có |
| `python` | Python app/library | `uv run pytest` |
| `data` | ETL/dbt/DVC/notebook/data pipeline | pytest hoặc dbt compile nếu có |
| `devops` | Docker/Terraform/K8s/GitHub Actions | diff check, compose/terraform validate nếu tool có |
| `mobile` | React Native/Flutter | npm test / flutter test nếu tool có |
| `docs` | Docs portal/manual | markdown diff check + test nếu project có |

## Runtime profile selection

Default UX không bắt buộc chạy bash để set profile. Sau global install, vào project chạy:

```text
/onboard-project
```

Nếu chưa có `.pi/piagent-profile.json`, onboarding nên dùng select-style setup: chọn profile trước, rồi chọn tech theo role. Native command là:

```text
/profile setup
/profile tech setup fullstack
```

Nếu Pi host chưa expose select UI, command trả về card compact và lệnh deterministic, ví dụ:

```text
/profile tech apply fullstack frontend=nextjs backend=nestjs database=prisma
```

Kết quả ghi:

- `.pi/piagent-profile.json`;
- `.pi/piagent-profile.lock.json`;
- `.pi/tech-stack.json`;
- `.pi/tech-context/<tech>.json` placeholder.

Sau khi agent đọc Context7 cho tech tương ứng, chỉ record snapshot ngắn bằng `piagent_profile_tech_context_record`; không lưu nguyên văn docs dài.

`/onboard-project` cũng tạo `.pi/context-index.json`. Đây là advisory node/edge/citation map cho profile, tech, verify command, docs, risk và memory pointer; không dùng thay thế source hiện tại hoặc guard policy.

Đổi profile sau này:

```text
/profile list
/profile be-readonly-fe
/profile tech setup
```

## Auto detect trong shell script

`scripts/init-project.sh` và `scripts/setup.sh` vẫn hỗ trợ `--profile auto` cho case preseed/CI. Logic detect dựa trên marker:

- mobile: `pubspec.yaml`, hoặc `android/` + `ios/`;
- fullstack: package frontend + backend marker cùng tồn tại;
- frontend: Next/React/Vite/Vue/Svelte/Astro marker;
- backend: Nest/Express/Fastify/Hono/Prisma, Java Maven/Gradle, hoặc FastAPI/Flask/Django;
- data: dbt/DVC/notebooks/data marker;
- python: `pyproject.toml`;
- node-typescript: `package.json` + `tsconfig.json`;
- devops: Docker/compose/Terraform/K8s/Helm/GitHub Actions;
- docs: docs portal markers;
- fallback: `generic`.

Auto detect là bootstrap convenience, không phải policy cuối cùng. Sau init, `.pi/piagent-profile.json` là source of truth của project.

Mọi built-in adapter đều đưa `.pi/project-context.md` vào `requiredContext`. File này được tạo dạng placeholder khi init project, rồi được model thay bằng snapshot thật sau `/onboard-project`.

## Khi nào cần custom profile

Custom profile khi project có ít nhất một điểm sau:

- verify command riêng;
- protected path riêng;
- context bắt buộc riêng;
- tool/MCP capability riêng;
- runtime policy riêng;
- rule domain hoặc compliance riêng.

Không sửa core extension chỉ để phục vụ một repo. Sửa `.pi/piagent-profile.json` của repo đó trước.

## Adapter BE readonly → FE write

Dùng `adapters/be-readonly-fe/profile.json` khi task pattern là:

- đọc BE controller/DTO/schema/test để map contract;
- không được sửa backend;
- chỉ implement frontend;
- nếu BE thiếu/gãy contract thì report gap.

Không để `auto` tự chọn adapter này vì BE read-only là policy decision, không phải marker kỹ thuật.

## Project-specific profiles

Project-specific profiles should live in the target project repository, not in this public core repo.

Use `examples/private/` locally if a maintainer needs private examples; that path is ignored by git.
