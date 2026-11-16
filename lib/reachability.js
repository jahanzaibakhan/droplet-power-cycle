const net = require("net");

const DEFAULT_PORTS = [22, 80, 443];
const DEFAULT_TIMEOUT_MS = 3500;

function probePort(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    function done(state, error) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, state, ms: Date.now() - started, error: error || undefined });
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done("open"));
    socket.once("timeout", () => done("timeout"));
    socket.once("error", (err) => {
      // A refused connection still proves the host's network stack is answering.
      if (err.code === "ECONNREFUSED") return done("refused");
      if (err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH") return done("unreachable", err.code);
      done("error", err.code || err.message);
    });
    socket.connect(port, ip);
  });
}

async function probeHost(ip, { ports = DEFAULT_PORTS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const results = await Promise.all(ports.map((port) => probePort(ip, port, timeoutMs)));
  const alive = results.some((r) => r.state === "open" || r.state === "refused");
  const open = results.filter((r) => r.state === "open").map((r) => r.port);
  return {
    ip,
    reachable: alive,
    open_ports: open,
    ports: results,
    checked_at: new Date().toISOString(),
  };
}

module.exports = { probeHost, DEFAULT_PORTS };
