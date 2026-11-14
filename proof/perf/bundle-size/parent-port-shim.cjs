// Gives a Node child the `process.parentPort` an Electron utility process has, over the fork's IPC
// channel, so the built receiver.cjs runs unchanged as a plain child process.
process.parentPort = {
  postMessage: (message) => process.send(message),
  on: (_event, listener) => process.on('message', (data) => listener({ data })),
};
