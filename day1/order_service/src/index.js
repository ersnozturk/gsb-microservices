const http = require('http'); // HTTP sunucusu oluşturmak için
const os = require('os'); // İşletim sistemi bilgisi (hostname) almak için
const client = require('prom-client'); // Prometheus metrikleri toplamak için
const { Pool } = require('pg'); // PostgreSQL veritabanı bağlantı havuzu için
const amqp = require('amqplib'); // RabbitMQ mesaj kuyruğu ile iletişim için

const PORT = 7000;
const INSTANCE_ID = os.hostname();
const POSTGRES_URI = process.env.POSTGRES_URI || 'postgresql://orderuser:orderpass@localhost:5432/orderdb';
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://guest:guest@localhost:5672';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:6000';

// ========================================
// Prometheus Metrikleri (mevcut)
// ========================================
client.collectDefaultMetrics({ prefix: 'nodejs_' });

const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Toplam HTTP istek sayisi',
    labelNames: ['method', 'path', 'status']
});

// ========================================
// PostgreSQL Bağlantısı
// ========================================
const pool = new Pool({ connectionString: POSTGRES_URI });

// ========================================
// RabbitMQ Producer
// ========================================
let rabbitChannel = null;

async function connectRabbitMQ() {
    try {
        const conn = await amqp.connect(RABBITMQ_URI);
        rabbitChannel = await conn.createChannel();
        await rabbitChannel.assertExchange('order_events', 'fanout', { durable: true });
        console.log(`[${INSTANCE_ID}] RabbitMQ producer bağlantısı başarılı`);
    } catch (err) {
        console.error(`[${INSTANCE_ID}] RabbitMQ bağlantı hatası:`, err.message);
        setTimeout(connectRabbitMQ, 5000);
    }
}

// Event yayınla
function publishEvent(eventName, data) {
    if (!rabbitChannel) {
        console.error(`[${INSTANCE_ID}] RabbitMQ channel yok, event gönderilemedi`);
        return;
    }
    const message = { event: eventName, data, timestamp: new Date().toISOString() };
    rabbitChannel.publish('order_events', '', Buffer.from(JSON.stringify(data)));
    console.log(`[${INSTANCE_ID}] Event yayınlandı: ${eventName} ->`, data);
}

// ========================================
// SENKRON İletişim - Product Service'e HTTP İsteği
// ========================================
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve({ statusCode: res.statusCode, data: JSON.parse(body) }); }
                catch { reject(new Error('JSON parse hatası')); }
            });
        }).on('error', reject);
    });
}

// ========================================
// DB - Tablo oluştur & Seed data
// ========================================
async function initDatabase() {
    // Orders tablosunu oluştur
    await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id          SERIAL PRIMARY KEY,
            product_id  VARCHAR(50) NOT NULL,
            product_name VARCHAR(255),
            quantity    INTEGER NOT NULL CHECK (quantity > 0),
            unit_price  DECIMAL(10,2),
            total_price DECIMAL(10,2),
            status      VARCHAR(20) DEFAULT 'created',
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log(`[${INSTANCE_ID}] PostgreSQL orders tablosu hazır`);
}

// ========================================
// HTTP Helpers
// ========================================
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { resolve({}); }
        });
        req.on('error', reject);
    });
}

function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

// ========================================
// HTTP Server - REST API
// ========================================
const server = http.createServer(async (req, res) => {

    // Prometheus metrics
    if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': client.register.contentType });
        const data = await client.register.metrics();
        res.end(data);
        return;
    }

    // Health check
    if (req.url === '/health') {
        sendJSON(res, 200, { status: 'ok', service: 'order-service', instance: INSTANCE_ID });
        return;
    }

    try {
        // ── GET /orders ── Tüm siparişleri listele
        if (req.method === 'GET' && req.url === '/orders') {
            const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
            httpRequestsTotal.inc({ method: 'GET', path: '/orders', status: 200 });
            sendJSON(res, 200, { success: true, count: result.rows.length, data: result.rows });
            return;
        }

        // ── GET /orders/:id ── Tek sipariş detayı
        const getMatch = req.url.match(/^\/orders\/(\d+)$/);
        if (req.method === 'GET' && getMatch) {
            const result = await pool.query('SELECT * FROM orders WHERE id = $1', [getMatch[1]]);
            if (result.rows.length === 0) {
                httpRequestsTotal.inc({ method: 'GET', path: '/orders/:id', status: 404 });
                sendJSON(res, 404, { success: false, error: 'Sipariş bulunamadı' });
                return;
            }
            httpRequestsTotal.inc({ method: 'GET', path: '/orders/:id', status: 200 });
            sendJSON(res, 200, { success: true, data: result.rows[0] });
            return;
        }

        // ── POST /orders ── Yeni sipariş oluştur
        //    1) SENKRON: Product Service'ten ürün bilgisi al (HTTP)
        //    2) Siparişi PostgreSQL'e kaydet
        //    3) ASENKRON: RabbitMQ'ya "order.created" event'i gönder
        if (req.method === 'POST' && req.url === '/orders') {
            const body = await parseBody(req);

            if (!body.productId || !body.quantity) {
                sendJSON(res, 400, { success: false, error: 'productId ve quantity zorunludur' });
                return;
            }

            // ── STEP 1: SENKRON İletişim ──
            // Product Service'e HTTP GET isteği atarak ürün bilgisini al
            console.log(`[${INSTANCE_ID}] SENKRON >> Product Service'e istek: ${PRODUCT_SERVICE_URL}/products/${body.productId}`);
            const productRes = await httpGet(`${PRODUCT_SERVICE_URL}/products/${body.productId}`);

            if (productRes.statusCode !== 200 || !productRes.data.success) {
                httpRequestsTotal.inc({ method: 'POST', path: '/orders', status: 404 });
                sendJSON(res, 404, { success: false, error: 'Ürün bulunamadı', productId: body.productId });
                return;
            }

            const product = productRes.data.data;
            console.log(`[${INSTANCE_ID}] SENKRON << Ürün bulundu: ${product.name} (stok: ${product.stock})`);

            // Stok kontrolü
            if (product.stock < body.quantity) {
                httpRequestsTotal.inc({ method: 'POST', path: '/orders', status: 400 });
                sendJSON(res, 400, {
                    success: false,
                    error: 'Yetersiz stok',
                    available: product.stock,
                    requested: body.quantity
                });
                return;
            }

            // ── STEP 2: Siparişi kaydet ──
            const totalPrice = product.price * body.quantity;
            const result = await pool.query(
                `INSERT INTO orders (product_id, product_name, quantity, unit_price, total_price, status)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [body.productId, product.name, body.quantity, product.price, totalPrice, 'created']
            );
            const order = result.rows[0];
            console.log(`[${INSTANCE_ID}] Sipariş kaydedildi: #${order.id}`);

            // ── STEP 3: ASENKRON İletişim ──
            // RabbitMQ'ya event gönder → Product Service stoğu düşürecek
            console.log(`[${INSTANCE_ID}] ASENKRON >> RabbitMQ'ya event gönderiliyor: order.created`);
            publishEvent('order.created', {
                orderId: order.id,
                productId: body.productId,
                quantity: body.quantity
            });

            httpRequestsTotal.inc({ method: 'POST', path: '/orders', status: 201 });
            sendJSON(res, 201, {
                success: true,
                message: 'Sipariş oluşturuldu. Stok asenkron olarak güncellenecek.',
                data: order,
                communication: {
                    sync:  'HTTP GET → Product Service (ürün bilgisi & stok kontrolü)',
                    async: 'RabbitMQ → order.created event (stok düşürme)'
                }
            });
            return;
        }

        // 404
        httpRequestsTotal.inc({ method: req.method, path: req.url, status: 404 });
        sendJSON(res, 404, { success: false, error: 'Endpoint bulunamadı' });

    } catch (err) {
        console.error(`[${INSTANCE_ID}] Hata:`, err.message);
        httpRequestsTotal.inc({ method: req.method, path: req.url, status: 500 });
        sendJSON(res, 500, { success: false, error: err.message });
    }
});

// ========================================
// Başlatma
// ========================================
async function start() {
    // 1) PostgreSQL tabloları
    await initDatabase();

    // 2) RabbitMQ producer
    await connectRabbitMQ();

    // 3) HTTP server
    server.listen(PORT, () => {
        console.log(`[${INSTANCE_ID}] Order Service ${PORT} portunda çalışıyor`);
    });
}

start().catch(err => {
    console.error('Başlatma hatası:', err);
    process.exit(1);
});