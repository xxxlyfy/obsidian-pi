// Fake Pi RPC child that answers `set_session_name` with an error response and
// succeeds at every other command. A rename can therefore be observed failing for
// real -- the client, the spawned child process and the response all exist -- which
// is what the shared fake-pi-rpc.mjs fixture cannot express, because it succeeds at
// every command it does not know.
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

const RENAME_FAILURE = "Pi refused to rename the session.";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(command) {
  if (command.type === "set_session_name") {
    send({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error: RENAME_FAILURE
    });
    return;
  }

  send({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    data: {}
  });
}
