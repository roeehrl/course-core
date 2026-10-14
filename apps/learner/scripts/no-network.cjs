// Preloaded by check-expo.mjs. Refuses every outbound non-loopback socket and
// records the attempt so the check fails even if the caller swallows the error.
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");

const log = process.env.COURSE_CORE_NETWORK_LOG;
const loopback = new Set(["localhost", "127.0.0.1", "::1"]);

function refuse(target) {
  if (log) fs.appendFileSync(log, `${target}\n`);
  const error = new Error(`Network access is disabled for the hermetic Expo check (${target})`);
  error.code = "ENETUNREACH";
  return error;
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  const options = typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  if (options.path === undefined && !loopback.has(options.host ?? "localhost")) {
    throw refuse(`${options.host}:${options.port}`);
  }
  return connect.apply(this, args);
};

for (const target of [dns, dns.promises]) {
  for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = function patchedDns(host, ...rest) {
      if (loopback.has(host)) return original.call(this, host, ...rest);
      throw refuse(`dns:${host}`);
    };
  }
}
