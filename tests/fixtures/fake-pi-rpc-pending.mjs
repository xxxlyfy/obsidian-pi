// Fake Pi RPC child that receives one-shot session commands and never answers them: the
// request stays pending for as long as the child lives, which is what a test needs to
// observe the client and the process while an operation is still in flight. It first
// reports that it received the command, so a test can distinguish "Pi never answered"
// from "the request never arrived". Every other command succeeds, like the shared
// fake-pi-rpc.mjs fixture.
const NEVER_ANSWERED = new Set([
  "set_session_name",
  "get_session_stats",
  "get_tree",
  "export_html"
]);

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    let line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line) handle(JSON.parse(line));
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(command) {
  if (NEVER_ANSWERED.has(command.type)) {
    // Deliberately no response: the request is received and left pending.
    send({ type: "request_pending", command: command.type });
    return;
  }

  send({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    data: command.type === "get_state" ? { isStreaming: false, pid: process.pid } : {}
  });
}
