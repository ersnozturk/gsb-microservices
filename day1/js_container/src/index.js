const http = require('http');
const client = require('prom-client');

const PORT = 6000;

const server = http.createServer(async (req, res) => {
    
res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });

res.end('Hello from JS container.');
console.log(`Server received a request`);

});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});