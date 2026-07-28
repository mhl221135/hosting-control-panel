const http = require("http");
const { spawn } = require("child_process");
const { safeEqual, validateArgs, validateCopy } = require("./policy");

const PORT = Number(process.env.PORT || 8790);
const TOKEN = String(process.env.HOSTING_AGENT_TOKEN || "");
const MAX_STDERR = 12 * 1024;

if (TOKEN.length < 32) {
  console.error("HOSTING_AGENT_TOKEN must contain at least 32 characters");
  process.exit(1);
}

function send(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function authorized(req) {
  const match = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
  return Boolean(match && safeEqual(match[1], TOKEN));
}

function decodeArgs(req) {
  const encoded = String(req.headers["x-hosting-args"] || "");
  if (!encoded || encoded.length > 64 * 1024) throw Object.assign(new Error("Command metadata is invalid"), { statusCode: 400 });
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function run(res, req, args) {
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let ended = false;
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    "Trailer": "X-Exit-Code, X-Stderr",
  });
  req.pipe(child.stdin);
  child.stdout.pipe(res, { end: false });
  child.stderr.on("data", (chunk) => {
    if (args[0] === "logs") {
      res.write(chunk);
    } else if (stderr.length < MAX_STDERR) {
      stderr += chunk.toString().slice(0, MAX_STDERR - stderr.length);
    }
  });
  child.on("error", (error) => {
    stderr = error.message;
    if (!ended) {
      ended = true;
      res.addTrailers({ "X-Exit-Code": "127", "X-Stderr": Buffer.from(stderr).toString("base64url") });
      res.end();
    }
  });
  child.on("close", (code) => {
    if (ended) return;
    ended = true;
    res.addTrailers({
      "X-Exit-Code": String(Number.isInteger(code) ? code : 1),
      "X-Stderr": Buffer.from(stderr).toString("base64url"),
    });
    res.end();
  });
  res.on("close", () => {
    if (!ended) child.kill("SIGKILL");
  });
}

function copy(res, req, destination) {
  const target = validateCopy(destination);
  run(res, req, [
    "exec", "-i", target.container, "sh", "-c",
    'umask 077; cat > "$1"', "agent-copy", target.path,
  ]);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (!authorized(req)) {
    send(res, 401, { ok: false, message: "Authentication required" });
    return;
  }
  try {
    if (req.method === "POST" && req.url === "/v1/exec") {
      run(res, req, validateArgs(decodeArgs(req)));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/copy") {
      const metadata = decodeArgs(req);
      copy(res, req, metadata.destination);
      return;
    }
    send(res, 404, { ok: false, message: "Not found" });
  } catch (error) {
    send(res, error.statusCode || 400, { ok: false, message: error.message });
  }
});

server.headersTimeout = 15_000;
server.requestTimeout = 0;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hosting control agent listening on ${PORT}`);
});
