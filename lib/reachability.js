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

const REACHABILITY_WAIT_MS = 4 * 60 * 1000;

/**
 * Providers mark power cycle / start done as soon as the VM is "running", even when the host
 * or OS never comes back. Hold the action open until the server answers, then give up.
 */
function settleWithReachability({ apiComplete, elapsedMs, probe }) {
  if (!apiComplete) return { status: "in-progress", note: null };
  if (!probe || probe.reachable) return { status: "completed", note: null };
  if (elapsedMs < REACHABILITY_WAIT_MS) {
    return {
      status: "in-progress",
      note: "Provider reports running — waiting for the server to answer on the network…",
    };
  }
  return {
    status: "unreachable",
    note:
      "Provider reports the server running, but it still does not answer on ports " +
      probe.ports.map((p) => p.port).join(", ") +
      ". Likely a host node or OS problem — contact the provider.",
  };
}

function unreachableMessage(probe, providerLabel) {
  return (
    `${providerLabel} reports the server as running, but it is not answering on ports ` +
    probe.ports.map((p) => p.port).join(", ") +
    `. This usually points to a host node, network, or OS-level failure that the ${providerLabel} API does not expose.`
  );
}

module.exports = { probeHost, settleWithReachability, unreachableMessage, DEFAULT_PORTS, REACHABILITY_WAIT_MS };
