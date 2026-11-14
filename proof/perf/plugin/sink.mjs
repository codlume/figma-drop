// A stand-in receiver: drains the POST body and replies with its byte count.
import http from 'node:http';

const server = http.createServer((request, response) => {
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
  });
  request.on('end', () => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ path: String(bytes) }));
  });
});
server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => console.log(server.address().port));
