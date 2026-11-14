process.parentPort = {
  postMessage: (m) => process.send(m),
  on: (ev, l) => process.on('message', (d) => l({ data: d })),
};
