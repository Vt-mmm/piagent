# Capability packs

## Tổng quan

Capability pack là đơn vị khai báo tài nguyên dùng chung của Pi Agent Platform. Pack không thực thi code từ manifest. Manifest chỉ mô tả:

- danh tính, phiên bản, owner và lifecycle;
- artifact được cung cấp;
- dependency phiên bản chính xác;
- capability, path, network và external action cần thiết;
- profile activation;
- eval scenario bắt buộc.

Core package chịu trách nhiệm validate, resolve và tạo bằng chứng integrity. Project profile luôn là nguồn cấp quyền cuối cùng.

## Thành phần

```text
packs/<name>/
├─ pack.json
└─ recipes/
   └─ <recipe>.json

catalog/
└─ capabilities.json

.pi/
├─ piagent-profile.json
└─ piagent-profile.lock.json
```

| Thành phần | Vai trò |
|---|---|
| `pack.json` | Manifest có schema, owner, version, artifact, dependency và permission. |
| Capability recipe | Step graph khai báo mode, dependency, timeout, retry, output và gate. |
| Catalog | Index deterministic của toàn bộ pack và artifact digest. |
| Project profile | Chọn pack và cấp quyền owner/lifecycle/network/action. |
| Profile lock | Kết quả resolve có profile digest, pack digest và effective permissions. |

## Lệnh vận hành

Kiểm tra catalog hiện tại:

```bash
piagent-capabilities catalog --check
```

Tạo lại catalog sau thay đổi được phê duyệt:

```bash
piagent-capabilities catalog --write
```

Resolve profile ra stdout:

```bash
piagent-capabilities resolve \
  --profile adapters/generic/profile.json
```

Tạo lock bên cạnh profile project:

```bash
piagent-capabilities resolve \
  --profile /path/to/project/.pi/piagent-profile.json \
  --output /path/to/project/.pi/piagent-profile.lock.json \
  --package-source npm:@your-scope/platform@x.y.z
```

Cập nhật profile và lock theo đường fail-closed:

```bash
piagent-capabilities apply-profile \
  --profile adapters/generic/profile.json \
  --target /path/to/project/.pi/piagent-profile.json \
  --package-source git:github.com/Vt-mmm/piagent@vX.Y.Z \
  --force
```

Kiểm tra profile và lock:

```bash
piagent-capabilities doctor \
  --profile /path/to/project/.pi/piagent-profile.json \
  --lock /path/to/project/.pi/piagent-profile.lock.json \
  --package-source npm:@your-scope/platform@x.y.z
```

Kiểm tra external action proposal dạng dry-run:

```bash
piagent-capabilities validate-action --file proposal.json
```

`scripts/init-project.sh` tự tạo `piagent-profile.lock.json` sau khi áp dụng profile.

## Profile selection

```json
{
  "capabilityPacks": [
    {
      "name": "engineering-base",
      "version": "0.1.1"
    }
  ],
  "capabilityPolicy": {
    "allowedOwners": [
      "platform-maintainers"
    ],
    "allowedLifecycles": [
      "experimental"
    ],
    "allowedFilesystemRead": [
      "**/*"
    ],
    "allowedFilesystemWrite": [
      "**/*"
    ],
    "allowedNetworkDomains": [],
    "allowedExternalActions": []
  }
}
```

Pack không thể cấp thêm quyền cho chính nó:

- capability phải có trong `mcpCapabilities` của profile;
- owner và lifecycle phải được profile cho phép;
- filesystem read/write scope phải exact-match grant tương ứng của profile;
- built-in path-like tool và tool có định danh `fs`/`filesystem` bị giới hạn theo filesystem scope đã resolve; đường dẫn thoát khỏi repository hoặc đi qua symlink bị từ chối. Tool khác tiếp tục qua tool registry. Base-policy protected path luôn có ưu tiên deny cao hơn; shell command vẫn chịu shell protected-path và exec-policy gate;
- network domain phải exact-match allowlist;
- external action phải exact-match allowlist;
- task contract và runtime policy vẫn có thể thu hẹp thêm quyền.

## Security properties

### Input boundary

- Chỉ nhận JSON với field đã khai báo.
- Reject key nguy hiểm và nesting trên 32 cấp.
- Giới hạn manifest 256 KiB và artifact 2 MiB.
- Artifact path phải là đường dẫn tương đối trong repository.
- Reject absolute path, parent traversal, backslash và symlink.
- Protected-path matching không phân biệt hoa/thường; runtime canonicalize đường dẫn hiện hữu để chặn alias hoặc symlink trỏ vào vùng được bảo vệ.

### Integrity

- Manifest và artifact dùng SHA-256 digest.
- Catalog và lock dùng canonical key order.
- Artifact ID là duy nhất trên toàn catalog để liên kết recipe không mơ hồ.
- Không có timestamp trong generated contract.
- Doctor phát hiện catalog hoặc lock stale.
- Generated output dùng temporary file cùng thư mục, `fsync`, rồi atomic rename.
- Lock gắn với declared package-source identifier, package version, catalog và digest của các runtime enforcement file đang cài. Đây là integrity binding của runtime quan sát được, không phải chứng minh nguồn gốc cryptographic của package archive.
- Optional runtime package được cài bằng exact version; installer đối chiếu registry integrity với digest đã phê duyệt trước khi cài.
- Khi cập nhật profile, lock được ghi trước; nếu profile không thể ghi thì lock được rollback. Process interruption tạo trạng thái mismatch fail-closed thay vì áp dụng profile thiếu lock.

### Permission boundary

- Resolver chỉ chấp nhận permission là tập con của profile grant.
- Lock ghi lại `protectedPaths`, `shellProtectedPaths`, `readOnlyPaths` và filesystem scope do pack yêu cầu.
- Network và external action mặc định rỗng.
- Action proposal bắt buộc `riskLane=high-risk`, `dryRun=true`, `containsSecrets=false`.
- Proposal dùng canonical UTC timestamp, chưa hết hạn, có hiệu lực tối đa 24 giờ và không chứa raw payload hay credential.
- `validate-action` chỉ kiểm tra contract, thời hạn và secret indicator; không authorize action, không đối chiếu requested permission với profile/lock và không đọc artifact để xác minh digest/size.
- External action vẫn cần human confirmation và executor riêng trước khi có side effect.

## Lifecycle

| Trạng thái | Ý nghĩa |
|---|---|
| `experimental` | Đang pilot, profile phải opt-in rõ. |
| `stable` | Contract và eval đã đủ cho use case công bố. |
| `deprecated` | Vẫn resolve được khi profile cho phép, nhưng cần kế hoạch thay thế. |

Điều kiện promote lên `stable`:

1. Schema và doctor pass.
2. Không có dependency cycle hoặc permission không được cấp.
3. Eval scenario bắt buộc pass trên project pilot.
4. Security review không còn Critical/High.
5. Artifact contract và compatibility note đã được duyệt.

## Thêm capability pack

1. Tạo `packs/<name>/pack.json` theo `schemas/capability-pack.schema.json`.
2. Khai owner, exact version, lifecycle và permission tối thiểu.
3. Khai artifact ID duy nhất, artifact path hiện hữu; không dùng symlink.
4. Thêm recipe/eval nếu pack có workflow hoặc invariant riêng.
5. Chạy `npm test` và `npm run capabilities:catalog`.
6. Chạy `npm run verify` trước handoff.

## Giới hạn hiện tại

- Catalog là local file, chưa có remote discovery service.
- Lock là preflight và integrity contract; runtime guard xác minh lại trước mỗi tool call đối với profile hiện hành. `PIAGENT_PROFILE` trusted override và legacy profile chưa khai `capabilityPacks` nằm ngoài lock gate; khi lock lỗi chỉ nhóm recovery/read-only tool giới hạn được phép hoạt động.
- Eval scenario mới có schema và validation; execution matrix được triển khai ở phase tiếp theo.
- Recipe binding nội bộ và eval scenario ID được kiểm tra trong exact dependency graph; capability binding vẫn do runtime tool registry giải quyết.
- External action proposal chỉ được validate; authorization, artifact byte verification và executor có credential không nằm trong phạm vi này.
