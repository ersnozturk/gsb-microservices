const http = require('http');
const os = require('os');
const client = require('prom-client');
const mongoose = require('mongoose');
const amqp = require('amqplib');

const PORT = 6000;
const INSTANCE_ID = os.hostname();
const MONGO_URI = process.env.MONGO_URI || 'mongodb://root:secret@localhost:27017/productdb?authSource=admin';
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://guest:guest@localhost:5672';

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
// MongoDB - Ürün Modeli
// ========================================
const productSchema = new mongoose.Schema({
    name:  { type: String, required: true },
    price: { type: Number, required: true },
    stock: { type: Number, required: true, default: 0 },
    category: { type: String, default: 'general' },
    createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// ========================================
// RabbitMQ Consumer - Sipariş geldiğinde stok düşür
// ========================================
async function startRabbitMQConsumer() {
    try {
        const conn = await amqp.connect(RABBITMQ_URI);
        const channel = await conn.createChannel();

        // Exchange ve Queue tanımla
        await channel.assertExchange('order_events', 'fanout', { durable: true });
        const q = await channel.assertQueue('product_stock_update', { durable: true });
        await channel.bindQueue(q.queue, 'order_events', '');

        console.log(`[${INSTANCE_ID}] RabbitMQ consumer başlatıldı - "product_stock_update" dinleniyor`);

        channel.consume(q.queue, async (msg) => {
            if (msg) {
                const event = JSON.parse(msg.content.toString());
                console.log(`[${INSTANCE_ID}] Event alındı: order.created ->`, event);

                try {
                    // Stok düşür
                    const product = await Product.findById(event.productId);
                    if (product) {
                        product.stock -= event.quantity;
                        await product.save();
                        console.log(`[${INSTANCE_ID}] Stok güncellendi: ${product.name} -> yeni stok: ${product.stock}`);
                    }
                    channel.ack(msg);
                } catch (err) {
                    console.error(`[${INSTANCE_ID}] Stok güncelleme hatası:`, err.message);
                    channel.nack(msg, false, true); // Tekrar kuyruğa koy
                }
            }
        });
    } catch (err) {
        console.error(`[${INSTANCE_ID}] RabbitMQ bağlantı hatası:`, err.message);
        // 5 saniye sonra tekrar dene
        setTimeout(startRabbitMQConsumer, 5000);
    }
}

// ========================================
// Seed Data - İlk ürünleri oluştur
// ========================================
async function seedProducts() {
    const count = await Product.countDocuments();
    if (count === 0) {
        const products = [
            { name: 'Laptop',     price: 25000, stock: 50,  category: 'electronics' },
            { name: 'Kulaklık',   price: 500,   stock: 200, category: 'electronics' },
            { name: 'Klavye',     price: 750,    stock: 100, category: 'electronics' },
            { name: 'Tişört',     price: 150,    stock: 300, category: 'clothing' },
            { name: 'Kitap - Node.js', price: 80, stock: 150, category: 'books' },
        ];
        await Product.insertMany(products);
        console.log(`[${INSTANCE_ID}] Seed veriler eklendi (${products.length} ürün)`);
    }
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
        sendJSON(res, 200, { status: 'ok', service: 'product-service', instance: INSTANCE_ID });
        return;
    }

    try {
        // ── GET /products ── Tüm ürünleri listele
        if (req.method === 'GET' && req.url === '/products') {
            const products = await Product.find().sort({ createdAt: -1 });
            httpRequestsTotal.inc({ method: 'GET', path: '/products', status: 200 });
            sendJSON(res, 200, { success: true, count: products.length, data: products });
            return;
        }

        // ── GET /products/:id ── Tek ürün detayı
        const getMatch = req.url.match(/^\/products\/([a-f0-9]{24})$/);
        if (req.method === 'GET' && getMatch) {
            const product = await Product.findById(getMatch[1]);
            if (!product) {
                httpRequestsTotal.inc({ method: 'GET', path: '/products/:id', status: 404 });
                sendJSON(res, 404, { success: false, error: 'Ürün bulunamadı' });
                return;
            }
            httpRequestsTotal.inc({ method: 'GET', path: '/products/:id', status: 200 });
            sendJSON(res, 200, { success: true, data: product });
            return;
        }

        // ── POST /products ── Yeni ürün ekle
        if (req.method === 'POST' && req.url === '/products') {
            const body = await parseBody(req);
            const product = await Product.create(body);
            console.log(`[${INSTANCE_ID}] Yeni ürün eklendi: ${product.name}`);
            httpRequestsTotal.inc({ method: 'POST', path: '/products', status: 201 });
            sendJSON(res, 201, { success: true, data: product });
            return;
        }

        // ── PUT /products/:id/stock ── Stok güncelle (manuel)
        const stockMatch = req.url.match(/^\/products\/([a-f0-9]{24})\/stock$/);
        if (req.method === 'PUT' && stockMatch) {
            const body = await parseBody(req);
            const product = await Product.findByIdAndUpdate(
                stockMatch[1],
                { stock: body.stock },
                { new: true }
            );
            if (!product) {
                httpRequestsTotal.inc({ method: 'PUT', path: '/products/:id/stock', status: 404 });
                sendJSON(res, 404, { success: false, error: 'Ürün bulunamadı' });
                return;
            }
            httpRequestsTotal.inc({ method: 'PUT', path: '/products/:id/stock', status: 200 });
            sendJSON(res, 200, { success: true, data: product });
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
    // 1) MongoDB bağlantısı
    await mongoose.connect(MONGO_URI);
    console.log(`[${INSTANCE_ID}] MongoDB bağlantısı başarılı`);

    // 2) Seed data
    await seedProducts();

    // 3) RabbitMQ consumer başlat
    startRabbitMQConsumer();

    // 4) HTTP server
    server.listen(PORT, () => {
        console.log(`[${INSTANCE_ID}] Product Service ${PORT} portunda çalışıyor`);
    });
}

start().catch(err => {
    console.error('Başlatma hatası:', err);
    process.exit(1);
});