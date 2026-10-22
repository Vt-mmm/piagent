export { companyTerminalDiagnostic } from './terminal-runtime.mjs';

// What a failed command tells the agent. Every environment failure names the
// way on (owner, 2026-10-13): a tool that asks the member's approval
// (run_with_network, run_with_docker, start_docker, fetch_origin, run_on_host)
// or a question to the member (ask_user), never "tell the user and stop".
const DENIAL = /\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/i;
// A download that never left the machine: resolvers, npm/pip, and the curl or
// wget a build wrapper runs (mvnw/gradlew fetch their distribution: "curl:
// Failed to fetch https://repo.maven.apache.org/…", "wget: Failed to fetch …").
const OFFLINE = /ENOTFOUND|EAI_AGAIN|Could not resolve host|getaddrinfo|npm error network|Failed to establish a new connection|\bcurl: (?:\(\d+\) )?Failed to (?:fetch|connect)|\bwget: (?:unable to resolve|Failed to fetch)|Unknown host|UnknownHostException/i;
// `network`: the member approved this command and it ran with network, so a
// name that does not resolve is the machine's network, not the sandbox.
// `isolated`: a proxy listens on this Mac, so without approval a command does
// not reach this Mac's own servers either (tool-boundary.mjs).
// Node's fetch reports that refusal as a bare "fetch failed" when a test
// runner prints the error without its cause (node --test on Node 22).
// `docker`: the command ran with the Docker engine (run_with_docker);
// `engine`: one is there for run_with_docker, but this command ran without it.
const DOCKER_DAEMON = /Cannot connect to the Docker daemon|connect to the docker API|docker\.sock|Is the docker daemon running|Could not find a valid Docker environment/i;
// A runtime or tool the command needs is not on this machine (or not the
// version the project asks for).
const TOOLCHAIN = /Unable to locate a Java Runtime|No Java runtime present|JAVA_HOME is not (?:set|defined correctly)|(?:^|\n)\S*?(?:ba|z)?sh: (?:line \d+: )?[\w.+-]+: command not found|zsh: command not found: [\w.+-]+|xcrun: error: (?:unable to find utility|invalid active developer path)|env: '?[\w.+-]+'?: No such file or directory|Unsupported class file major version|invalid target release: \d+|release version \d+ not supported|requires? (?:at least )?Java \d+|The engine "node" is incompatible|Unsupported engine/i;
// The member's sign-in, which the sandbox does not have.
const SIGN_IN = /could not read (?:Username|Password) for|terminal prompts disabled|Authentication failed for|Permission denied \(publickey|Host key verification failed|not logged into any GitHub hosts|please run:\s+gh auth login|Could not open a connection to your authentication agent|\bENEEDAUTH\b|\bE401\b|\b401 Unauthorized|requires authentication|denied: requested access to the resource is denied|pull access denied/i;

export function sandboxDiagnostic(message, { network = false, isolated = false, docker = false, engine = false } = {}) {
  const text=String(message);
  if(docker&&DOCKER_DAEMON.test(text))return 'managed-docker-unreachable: Lệnh chạy với Docker nhưng Docker engine không trả lời (Docker Desktop/Colima/OrbStack chưa chạy hoặc đang khởi động). Gọi start_docker để xin member duyệt mở Docker, rồi chạy lại đúng lệnh này bằng run_with_docker.\n'+text;
  if(!docker&&DOCKER_DAEMON.test(text))return (engine?'managed-docker-blocked: Lệnh bash thường không dùng được Docker trong chế độ công ty. Lệnh docker, docker compose, hoặc test cần Docker (Testcontainers) chạy qua run_with_docker để người dùng duyệt đúng lệnh đó.\n':'managed-docker-unavailable: Docker engine trên máy chưa chạy. Gọi start_docker để xin member duyệt mở Docker, rồi chạy lệnh bằng run_with_docker.\n')+text;
  if(TOOLCHAIN.test(text))return 'managed-toolchain-missing: Máy thiếu runtime/công cụ mà lệnh cần, hoặc sai version project yêu cầu. Đừng dừng ở đây: xem project cần gì (pom.xml, build.gradle, .nvmrc, .tool-versions, package.json engines…) rồi dùng run_on_host để xin member duyệt cài trên máy (ví dụ brew install openjdk@21, brew install node@22, sdk install java 21-tem), sau đó chạy lại lệnh. Nếu project build được trong Docker thì có thể đề xuất run_with_docker. Trình cài cần mật khẩu (sudo, file .pkg) thì hỏi member bằng ask_user.\n'+text;
  if(SIGN_IN.test(text))return 'managed-credentials-unavailable: Lệnh cần tài khoản đăng nhập của member (git qua HTTPS/SSH, registry riêng, image riêng), sandbox không có. git fetch dùng fetch_origin; git pull, git push, cài từ registry riêng hoặc pull image riêng thì dùng run_on_host để member duyệt chạy đúng lệnh đó trên máy bằng tài khoản của họ.\n'+text;
  if(isolated&&!/CONNECT tunnel failed|tunneling socket|statusCode=403|response 403/i.test(text)&&/ECONNREFUSED|EPERM|connect|Connection refused|could not connect|fetch failed/i.test(text))return 'managed-loopback-blocked: Máy đang chạy một proxy cục bộ, nên lệnh không có mạng cũng không được kết nối tới server trên localhost (proxy có thể đưa lệnh ra internet). Test cần server hoặc database trên localhost: dùng run_with_network để người dùng duyệt đúng lệnh đó.\n'+text;
  if(network&&!DENIAL.test(text)&&OFFLINE.test(text))return 'managed-network-unreachable: Lệnh đã được duyệt và chạy có mạng nhưng không tới được host (máy offline, cần VPN/proxy công ty, hoặc sai tên host). Hỏi member bằng ask_user, kèm lựa chọn "Đã kết nối mạng/VPN, chạy lại" và "Bỏ qua bước này"; member trả lời xong thì làm theo.\n'+text;
  if(!DENIAL.test(text)&&OFFLINE.test(text))return 'managed-network-blocked: Lệnh bash thường không có mạng trong chế độ công ty. Nếu lệnh thật sự cần mạng (cài package, tải dữ liệu), dùng run_with_network để người dùng duyệt đúng lệnh đó.\n'+text;
  if(!DENIAL.test(text))return text;
  // /tmp is shared by every process on the Mac, so it stays read-only; each
  // command has its own temporary folder in $TMPDIR (Linux: a private /tmp).
  if(/(?:^|[\s'"=:(])\/(?:private\/)?tmp\//.test(text))return 'managed-sandbox-denied: /tmp chỉ được đọc trong chế độ công ty. Ghi file tạm (log, kết quả test) vào "$TMPDIR" (thư mục tạm riêng của lệnh, ví dụ "$TMPDIR/test.log") hoặc trong project.\n'+text;
  return 'managed-sandbox-denied: Sandbox chặn thao tác này (ghi ngoài project, Keychain, file credential như .env/.npmrc, thư mục hệ thống). Nếu task thật sự cần nó, dùng run_on_host để member duyệt chạy đúng lệnh đó trên máy, ngoài sandbox. Lệnh chỉ cần mạng thì dùng run_with_network; git fetch dùng fetch_origin.\n'+text;
}
