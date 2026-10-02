const DENIAL = /\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/i;
const OFFLINE = /ENOTFOUND|EAI_AGAIN|Could not resolve host|getaddrinfo|npm error network|Failed to establish a new connection/i;
// `network`: the member approved this command and it ran with network, so a
// name that does not resolve is the machine's network, not the sandbox.
export function sandboxDiagnostic(message, { network = false } = {}) {
  const text=String(message);
  if(network&&!DENIAL.test(text)&&OFFLINE.test(text))return 'managed-network-unreachable: Lệnh đã được duyệt và chạy có mạng nhưng không tới được host (máy đang offline, cần VPN/proxy công ty, hoặc sai tên host). Không xin duyệt lại cùng lệnh; báo người dùng lỗi mạng này.\n'+text;
  if(!DENIAL.test(text)&&OFFLINE.test(text))return 'managed-network-blocked: Lệnh bash thường không có mạng trong chế độ công ty. Nếu lệnh thật sự cần mạng (cài package, tải dữ liệu), dùng run_with_network để người dùng duyệt đúng lệnh đó.\n'+text;
  if(!DENIAL.test(text))return text;
  return 'managed-sandbox-denied: Công cụ bị giới hạn quyền trong chế độ công ty (hoặc quyền file của hệ điều hành). Keychain và file chứa credential như .env/.npmrc bị chặn. Lệnh cần mạng (cài package, tải dữ liệu) dùng run_with_network để xin duyệt; git fetch origin dùng fetch_origin. Không tự chạy lại bên ngoài sandbox.\n'+text;
}

