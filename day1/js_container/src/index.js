const http = require('http');
const os = require('os');
const client = require('prom-client');

const PORT = 6000;
const INSTANCE_ID = os.hostname();

// Varsayılan metrikleri topla (CPU, memory, event loop vb.)
client.collectDefaultMetrics({ prefix: 'nodejs_' });

// HTTP istek sayacı
const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Toplam HTTP istek sayisi',
    labelNames: ['method', 'path', 'status']
});

const server = http.createServer((req, res) => {
    // /metrics endpoint'i - Prometheus buradan veri çeker
    if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': client.register.contentType });
        client.register.metrics().then(data => res.end(data));
        return;
    }

    // Normal istek
    httpRequestsTotal.inc({ method: req.method, path: '/', status: 200 });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`instance: ${INSTANCE_ID}`);
    console.log(`[${INSTANCE_ID}] İstek alındı`);
});

server.listen(PORT, () => {
    console.log(`[${INSTANCE_ID}] Server ${PORT} portunda çalışıyor`);
});