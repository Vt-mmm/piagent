const DENIAL = /\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/i;
// A download that never left the machine: resolvers, npm/pip, and the curl or
// wget a build wrapper runs (mvnw/gradlew fetch their distribution: "curl:
// Failed to fetch https://repo.maven.apache.org/…").
const OFFLINE = /ENOTFOUND|EAI_AGAIN|Could not resolve host|getaddrinfo|npm error network|Failed to establish a new connection|\bcurl: (?:\(\d+\) )?Failed to (?:fetch|connect)|\bwget: unable to resolve|Unknown host|UnknownHostException/i;
// `network`: the member approved this command and it ran with network, so a
// name that does not resolve is the machine's network, not the sandbox.
// `isolated`: a proxy listens on this Mac, so without approval a command does
// not reach this Mac's own servers either (tool-boundary.mjs).
// `docker`: the command ran with the Docker engine (run_with_docker);
// `engine`: one is there for run_with_docker, but this command ran without it.
const DOCKER_DAEMON = /Cannot connect to the Docker daemon|connect to the docker API|docker\.sock|Is the docker daemon running|Could not find a valid Docker environment/i;
export function sandboxDiagnostic(message, { network = false, isolated = false, docker = false, engine = false } = {}) {
  const text=String(message);
  if(docker&&DOCKER_DAEMON.test(text))return 'managed-docker-unreachable: Lệnh chạy với Docker nhưng Docker engine không trả lời (Docker Desktop/Colima chưa chạy hoặc đang khởi động). Không xin duyệt lại cùng lệnh; báo người dùng mở Docker rồi thử lại.\n'+text;
  if(!docker&&DOCKER_DAEMON.test(text))return (engine?'managed-docker-blocked: Lệnh bash thường không dùng được Docker trong chế độ công ty. Lệnh docker, docker compose, hoặc test cần Docker (Testcontainers) chạy qua run_with_docker để người dùng duyệt đúng lệnh đó.\n':'managed-docker-unavailable: Máy chưa có Docker engine đang chạy (Docker Desktop, Colima, OrbStack…). Báo người dùng mở Docker; sau đó cuộc trò chuyện mới có run_with_docker.\n')+text;
  if(isolated&&/ECONNREFUSED|EPERM|connect|Connection refused|could not connect/i.test(text))return 'managed-loopback-blocked: Máy đang chạy một proxy cục bộ, nên lệnh không có mạng cũng không được kết nối tới server trên localhost (proxy có thể đưa lệnh ra internet). Test cần server hoặc database trên localhost: dùng run_with_network để người dùng duyệt đúng lệnh đó.\n'+text;
  if(network&&!DENIAL.test(text)&&OFFLINE.test(text))return 'managed-network-unreachable: Lệnh đã được duyệt và chạy có mạng nhưng không tới được host (máy đang offline, cần VPN/proxy công ty, hoặc sai tên host). Không xin duyệt lại cùng lệnh; báo người dùng lỗi mạng này.\n'+text;
  if(!DENIAL.test(text)&&OFFLINE.test(text))return 'managed-network-blocked: Lệnh bash thường không có mạng trong chế độ công ty. Nếu lệnh thật sự cần mạng (cài package, tải dữ liệu), dùng run_with_network để người dùng duyệt đúng lệnh đó.\n'+text;
  if(!DENIAL.test(text))return text;
  // /tmp is shared by every process on the Mac, so it stays read-only; each
  // command has its own temporary folder in $TMPDIR (Linux: a private /tmp).
  if(/(?:^|[\s'"=:(])\/(?:private\/)?tmp\//.test(text))return 'managed-sandbox-denied: /tmp chỉ được đọc trong chế độ công ty. Ghi file tạm (log, kết quả test) vào "$TMPDIR" (thư mục tạm riêng của lệnh, ví dụ "$TMPDIR/test.log") hoặc trong project. Không tự chạy lại bên ngoài sandbox.\n'+text;
  return 'managed-sandbox-denied: Công cụ bị giới hạn quyền trong chế độ công ty (hoặc quyền file của hệ điều hành). Keychain và file chứa credential như .env/.npmrc bị chặn. Lệnh cần mạng (cài package, tải dữ liệu) dùng run_with_network để xin duyệt; git fetch origin dùng fetch_origin. Không tự chạy lại bên ngoài sandbox.\n'+text;
}

