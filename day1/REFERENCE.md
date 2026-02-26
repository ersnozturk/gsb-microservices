# Mikroservisler Arası Haberleşme - Referans Döküman

## İçindekiler
1. [Mimari Genel Bakış](#1-mimari-genel-bakış)
2. [Senkron vs Asenkron Haberleşme](#2-senkron-vs-asenkron-haberleşme)
3. [RabbitMQ Temelleri](#3-rabbitmq-temelleri)
4. [Projede Kullanılan Yapı](#4-projede-kullanılan-yapı)
5. [Database per Service Pattern](#5-database-per-service-pattern)
6. [API Endpoint'leri](#6-api-endpointleri)
7. [Hands-on: Adım Adım Test](#7-hands-on-adım-adım-test) *(Linux/macOS + Windows PowerShell)*
8. [Sık Sorulan Sorular](#8-sık-sorulan-sorular)
9. [Erişim Bilgileri](#erişim-bilgileri)
10. [Faydalı Komutlar](#faydalı-komutlar)
11. [MongoDB Shell (mongosh) Kullanımı](#mongodb-shell-mongosh-kullanımı)
12. [PostgreSQL Shell (psql) Kullanımı](#postgresql-shell-psql-kullanımı)
13. [RabbitMQ Yönetimi](#rabbitmq-yönetimi)

---

## 1. Mimari Genel Bakış

```
┌─────────────┐       ┌──────────────────────────────────────────────────────┐
│   Client    │       │              Docker Network                         │
│  (curl/web) │       │                                                      │
└──────┬──────┘       │  ┌─────────┐                                        │
       │              │  │  NGINX  │  API Gateway & Load Balancer            │
       │  :8081       │  │  :80    │                                         │
       └──────────────┼─►│         │                                         │
                      │  └────┬────┘                                         │
                      │       │                                              │
                      │  ┌────┴──────────────────────┐                       │
                      │  │                           │                       │
                      │  ▼ /product/*                ▼ /order/*              │
                      │  ┌──────────────┐   ┌──────────────┐                 │
                      │  │   Product    │   │    Order     │                 │
                      │  │   Service    │◄──│   Service    │  ◄─ HTTP GET    │
                      │  │   :6000      │   │   :7000      │    (SENKRON)    │
                      │  └──────┬───────┘   └──────┬───────┘                 │
                      │         │                  │                         │
                      │         │    ┌─────────┐   │                         │
                      │         │◄───│RabbitMQ │◄──┘  ◄─ AMQP               │
                      │         │    │  :5672  │         (ASENKRON)          │
                      │         │    └─────────┘                             │
                      │         │                  │                         │
                      │         ▼                  ▼                         │
                      │  ┌──────────────┐   ┌──────────────┐                 │
                      │  │   MongoDB    │   │  PostgreSQL  │                 │
                      │  │   :27017     │   │   :5432      │                 │
                      │  └──────────────┘   └──────────────┘                 │
                      └──────────────────────────────────────────────────────┘
```

### Sipariş Akışı (Tüm adımlar)

```
1. Client ──POST /order/orders──► Nginx ──► Order Service
2. Order Service ──HTTP GET /products/:id──► Product Service     ← SENKRON
3. Product Service ──ürün bilgisi──► Order Service               ← SENKRON
4. Order Service ──INSERT──► PostgreSQL (sipariş kaydı)
5. Order Service ──publish "order.created"──► RabbitMQ           ← ASENKRON
6. RabbitMQ ──deliver──► Product Service (consumer)              ← ASENKRON
7. Product Service ──UPDATE stock──► MongoDB
```

---

## 2. Senkron vs Asenkron Haberleşme

### Senkron (Synchronous) - HTTP

```
Servis A ────istek────► Servis B
         ◄────cevap────
```

| Özellik | Açıklama |
|---------|----------|
| **Protokol** | HTTP/REST |
| **Çalışma şekli** | İstemci istek atar, cevabı **bekler** |
| **Avantajı** | Basit, anlaşılır, anında cevap alınır |
| **Dezavantajı** | Hedef servis çökerse çağıran da etkilenir (tight coupling) |
| **Ne zaman kullanılır?** | Cevaba **ihtiyacın olduğunda** (stok kontrolü, fiyat sorgulama) |

**Projedeki kullanım:**
```
Order Service ──HTTP GET──► Product Service
"Bu ürün var mı? Stoğu yeterli mi? Fiyatı ne?"
→ Cevabı BEKLEMEK zorunda çünkü sipariş oluşturmak için bu bilgi lazım
```

### Asenkron (Asynchronous) - Message Broker

```
Servis A ────mesaj────► [Message Broker] ────mesaj────► Servis B
         (gönder & unut)                   (ne zaman hazırsa)
```

| Özellik | Açıklama |
|---------|----------|
| **Protokol** | AMQP (RabbitMQ), Kafka, NATS, vb. |
| **Çalışma şekli** | Mesajı kuyruğa bırak, **bekleme** |
| **Avantajı** | Servisler bağımsız, biri çökse diğerini etkilemez (loose coupling) |
| **Dezavantajı** | Anında cevap alamazsın, debug zorlaşabilir |
| **Ne zaman kullanılır?** | Cevaba **ihtiyacın olmadığında** (bildirim, stok güncelleme, log) |

**Projedeki kullanım:**
```
Order Service ──event──► RabbitMQ ──event──► Product Service
"Sipariş oluştu, stoğu 2 adet düşür"
→ Cevabı BEKLEMEMEK yeterli çünkü sipariş zaten kaydedildi
```

### Karşılaştırma Tablosu

| Kriter             | Senkron (HTTP)              | Asenkron (RabbitMQ)               |
| ------------------ | --------------------------- | --------------------------------- |
| Hız                | Anında cevap                | Gecikmeli (ms~sn)                 |
| Bağımlılık         | Yüksek (tight coupling)     | Düşük (loose coupling)            |
| Hata dayanıklılığı | Düşük (servis çökerse fail) | Yüksek (mesaj kuyrukta bekler)    |
| Kullanım           | Veri sorgulama, validasyon  | Event yayınlama, arka plan işleri |
| Karmaşıklık        | Basit                       | Orta (broker yönetimi gerekir)    |

---

## 3. RabbitMQ Temelleri

### RabbitMQ Nedir?
- Açık kaynak **message broker** (mesaj aracısı)
- **AMQP** (Advanced Message Queuing Protocol) kullanır
- Mesajları **producer**'dan alır, **queue**'da tutar, **consumer**'a iletir

### Temel Kavramlar

```
┌──────────┐     ┌──────────┐     ┌─────────┐     ┌──────────┐
│ Producer │────►│ Exchange │────►│  Queue  │────►│ Consumer │
│ (Yayıncı)│     │ (Dağıtıcı)│     │ (Kuyruk)│     │ (Dinleyici)│
└──────────┘     └──────────┘     └─────────┘     └──────────┘
```

| Kavram | Açıklama | Projedeki Karşılığı |
|--------|----------|---------------------|
| **Producer** | Mesaj gönderen | Order Service |
| **Consumer** | Mesaj alan/işleyen | Product Service |
| **Exchange** | Mesajları yönlendiren | `order_events` (fanout) |
| **Queue** | Mesajların bekletildiği kuyruk | `product_stock_update` |
| **Binding** | Exchange → Queue bağlantısı | `order_events` → `product_stock_update` |
| **Message** | Gönderilen veri (JSON) | `{ orderId, productId, quantity }` |

### Exchange Tipleri

```
1. FANOUT (Bizim kullandığımız)
   ┌─────────┐     ┌─────────┐
   │ Queue A │◄────│         │
   └─────────┘     │         │
   ┌─────────┐     │ Exchange│◄──── Mesaj
   │ Queue B │◄────│ (fanout)│
   └─────────┘     │         │
   ┌─────────┐     │         │
   │ Queue C │◄────│         │
   └─────────┘     └─────────┘
   → Mesaj TÜM bağlı kuyruklara gider (broadcast)
   → Kullanım: Tüm servislerin bilmesi gereken event'ler

2. DIRECT
   Exchange routing key'e göre eşleşen kuyruğa yönlendirir
   → Kullanım: Belirli bir servise mesaj göndermek

3. TOPIC
   Exchange pattern matching ile yönlendirir (order.*, *.created)
   → Kullanım: Kategoriye göre filtreleme

4. HEADERS
   Mesaj header'larına göre yönlendirme
   → Kullanım: Karmaşık routing kuralları
```

### ACK/NACK Mekanizması

```javascript
// Consumer mesajı başarıyla işledi → ACK (Acknowledge)
channel.ack(msg);
// → RabbitMQ mesajı kuyruktan siler

// Consumer mesajı işleyemedi → NACK (Negative Acknowledge)
channel.nack(msg, false, true);
//                        ↑ true = mesajı tekrar kuyruğa koy (retry)
//                        ↑ false = mesajı at (dead letter queue'ya gider)
```

**Neden önemli?**
- Consumer çökmüş olsa bile mesaj **kaybolmaz** (durable queue)
- İşlenmemiş mesajlar kuyrukta bekler
- Consumer tekrar ayağa kalkınca kaldığı yerden devam eder

### Durable (Kalıcı) vs Transient (Geçici)

```javascript
// Durable Exchange - RabbitMQ restart'ta kaybolmaz
await channel.assertExchange('order_events', 'fanout', { durable: true });

// Durable Queue - RabbitMQ restart'ta kaybolmaz
await channel.assertQueue('product_stock_update', { durable: true });
```

---

## 4. Projede Kullanılan Yapı

### Producer Tarafı (Order Service)

```javascript
// 1. Bağlantı kur
const conn = await amqp.connect('amqp://guest:guest@rabbitmq:5672');
const channel = await conn.createChannel();

// 2. Exchange tanımla (yoksa oluştur)
await channel.assertExchange('order_events', 'fanout', { durable: true });

// 3. Mesaj yayınla
channel.publish(
    'order_events',                          // Exchange adı
    '',                                       // Routing key (fanout'ta kullanılmaz)
    Buffer.from(JSON.stringify({             // Mesaj içeriği (Buffer olmalı)
        orderId: 1,
        productId: '507f1f77bcf86cd799439011',
        quantity: 2
    }))
);
```

### Consumer Tarafı (Product Service)

```javascript
// 1. Bağlantı kur
const conn = await amqp.connect('amqp://guest:guest@rabbitmq:5672');
const channel = await conn.createChannel();

// 2. Exchange tanımla (yoksa oluştur - her iki taraf da yapar, idempotent)
await channel.assertExchange('order_events', 'fanout', { durable: true });

// 3. Queue tanımla
const q = await channel.assertQueue('product_stock_update', { durable: true });

// 4. Queue'yu Exchange'e bağla (binding)
await channel.bindQueue(q.queue, 'order_events', '');

// 5. Mesajları dinle
channel.consume(q.queue, async (msg) => {
    const event = JSON.parse(msg.content.toString());
    // → event = { orderId: 1, productId: '...', quantity: 2 }

    // İşle
    const product = await Product.findById(event.productId);
    product.stock -= event.quantity;
    await product.save();

    // Başarılıysa ACK
    channel.ack(msg);
});
```

### Mesaj Akışı Detayı

```
Order Service                    RabbitMQ                     Product Service
     │                              │                              │
     │  channel.publish(            │                              │
     │    'order_events',           │                              │
     │    '',                       │                              │
     │    {orderId,productId,qty})  │                              │
     │─────────────────────────────►│                              │
     │                              │  order_events (Exchange)     │
     │                              │      │                       │
     │                              │      ▼ (fanout → tüm queue) │
     │                              │  product_stock_update (Queue)│
     │                              │      │                       │
     │                              │      │  channel.consume()    │
     │                              │      └──────────────────────►│
     │                              │                              │
     │                              │                    İşle:     │
     │                              │              stock -= qty    │
     │                              │                              │
     │                              │         channel.ack(msg)     │
     │                              │◄─────────────────────────────│
     │                              │                              │
```

---

## 5. Database per Service Pattern

### Neden her servise ayrı veritabanı?

Monolitte tüm veriler tek DB'dedir. Mikroservislerde **her servis kendi verisine sahip olmalıdır**.

```
  ❌ YANLIŞ (Shared Database)          ✅ DOĞRU (Database per Service)
  ┌──────────┐  ┌──────────┐          ┌──────────┐  ┌──────────┐
  │ Servis A │  │ Servis B │          │ Servis A │  │ Servis B │
  └────┬─────┘  └────┬─────┘          └────┬─────┘  └────┬─────┘
       │              │                    │              │
       └──────┬───────┘                    ▼              ▼
              ▼                      ┌──────────┐  ┌──────────┐
        ┌──────────┐                 │   DB-A   │  │   DB-B   │
        │  Tek DB  │                 └──────────┘  └──────────┘
        └──────────┘
```

| Shared DB                            | Database per Service              |
| ------------------------------------ | --------------------------------- |
| Servisler birbirine bağımlı          | Servisler bağımsız                |
| Bir şema değişikliği herkesi etkiler | Her servis kendi şemasını yönetir |
| Scale zorlaşır                       | Her DB ayrı scale edilebilir      |
| Tek noktadan arıza (SPOF)            | Bir DB çökse diğeri etkilenmez    |

### Projemizdeki Veritabanları

| Servis | Veritabanı | Neden Bu DB? |
|--------|-----------|-------------|
| **Product Service** | **MongoDB** (NoSQL) | Ürünlerin farklı kategorilerde farklı özellikleri olabilir. Elektronik → RAM, storage; Giyim → beden, renk. MongoDB'nin **esnek şeması** buna çok uygun. Ayrıca **okuma ağırlıklı** katalog sorguları için yüksek performans sunar. |
| **Order Service** | **PostgreSQL** (SQL) | Siparişler **ilişkisel** ve **transactional** veridir. product_id referansı var, tutar hesaplamaları yapılıyor. **ACID garantisi** şart — finansal veri kaybedilemez. Bir sipariş ya tamamen oluşturulur ya da hiç oluşturulmaz. |

### MongoDB Şeması (Product)

```javascript
// Esnek şema - farklı ürünler farklı alanlar ekleyebilir
{
    name:      "Laptop",
    price:     25000,
    stock:     50,
    category:  "electronics",
    createdAt: "2026-02-25T10:00:00.000Z",
    _id:       "507f1f77bcf86cd799439011"    // MongoDB ObjectId
}
```

### PostgreSQL Şeması (Order)

```sql
-- Katı şema - her kayıt aynı yapıda, CHECK constraint ile veri bütünlüğü
CREATE TABLE orders (
    id          SERIAL PRIMARY KEY,            -- Otomatik artan ID
    product_id  VARCHAR(50) NOT NULL,          -- MongoDB'deki ürün ID referansı
    product_name VARCHAR(255),                 -- Denormalize (hız için)
    quantity    INTEGER NOT NULL CHECK (quantity > 0),  -- Min 1 adet
    unit_price  DECIMAL(10,2),                 -- Birim fiyat
    total_price DECIMAL(10,2),                 -- quantity × unit_price
    status      VARCHAR(20) DEFAULT 'created', -- Durum takibi
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 6. API Endpoint'leri

> **Windows kullanıcıları:** Aşağıdaki örneklerde `curl` komutları verilmiştir. Windows'ta **PowerShell** kullanıyorsanız `Invoke-RestMethod` (kısaca `irm`) veya `Invoke-WebRequest` (kısaca `iwr`) komutlarını kullanın. Her adımda her iki alternatif de gösterilmektedir.

### Product Service (Nginx: /product/*)

| Method | Endpoint | Açıklama | Body |
|--------|----------|----------|------|
| GET | `/product/products` | Tüm ürünleri listele | - |
| GET | `/product/products/:id` | Tek ürün detayı | - |
| POST | `/product/products` | Yeni ürün ekle | `{"name","price","stock","category"}` |
| PUT | `/product/products/:id/stock` | Stok güncelle | `{"stock": 100}` |

### Order Service (Nginx: /order/*)

| Method | Endpoint            | Açıklama                | Body                       |
| ------ | ------------------- | ----------------------- | -------------------------- |
| GET    | `/order/orders`     | Tüm siparişleri listele | -                          |
| GET    | `/order/orders/:id` | Tek sipariş detayı      | -                          |
| POST   | `/order/orders`     | Yeni sipariş oluştur    | `{"productId","quantity"}` |

---

## 7. Hands-on: Adım Adım Test

> **Platform notu:** Her adımda hem **Linux/macOS (bash + curl)** hem de **Windows (PowerShell)** komutları verilmiştir. Docker komutları her platformda aynıdır.

---

### Ön Hazırlık
```bash
# Tüm servisleri başlat (her platformda aynı)
docker compose up -d

# Servislerin hazır olduğunu kontrol et
docker compose ps

# Logları izle (ayrı terminal aç)
docker compose logs -f product_service order_service
```

---

### Adım 1: Ürünleri Listele

Product Service'teki tüm ürünleri MongoDB'den çeker.

**Linux / macOS:**
```bash
curl -s http://localhost:8081/product/products | python3 -m json.tool
```

**Windows PowerShell:**
```powershell
Invoke-RestMethod http://localhost:8081/product/products | ConvertTo-Json -Depth 5
```

> 5 adet seed ürün dönmeli: Laptop, Kulaklık, Klavye, Tişört, Kitap

---

### Adım 2: Bir Ürünün ID'sini Al

Bir sonraki adımlarda kullanmak üzere ilk ürünün `_id` değerini bir değişkene kaydedin.

**Linux / macOS:**
```bash
PRODUCT_ID=$(curl -s http://localhost:8081/product/products | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo $PRODUCT_ID
```

**Windows PowerShell:**
```powershell
$response = Invoke-RestMethod http://localhost:8081/product/products
$PRODUCT_ID = $response.data[0]._id
Write-Host $PRODUCT_ID
```

> Çıktı örneği: `67be3a1f5c2d4e001a8b1234`

---

### Adım 3: Ürün Detayını Getir (Sipariş öncesi stok notu)

Ürünün mevcut **stock** değerini not edin — sipariş sonrası düştüğünü doğrulayacağız.

**Linux / macOS:**
```bash
curl -s http://localhost:8081/product/products/$PRODUCT_ID | python3 -m json.tool
```

**Windows PowerShell:**
```powershell
Invoke-RestMethod http://localhost:8081/product/products/$PRODUCT_ID | ConvertTo-Json -Depth 5
```

> **stock** değerini not edin (örn: `50`)

---

### Adım 4: Sipariş Oluştur (SENKRON + ASENKRON Haberleşme)

Bu **tek istek** arkada 4 işlem tetikler:

```
┌──────────────────────────────────────────────────────────────┐
│  POST /order/orders {productId, quantity: 3}                 │
│                                                              │
│  1. SENKRON  → Order Service HTTP GET ile Product Service'e  │
│               istek atar: "Bu ürün var mı? Stok yeterli mi?" │
│                                                              │
│  2. SQL      → Sipariş PostgreSQL'e INSERT edilir            │
│                                                              │
│  3. ASENKRON → order.created event'i RabbitMQ'ya gönderilir  │
│                                                              │
│  4. ASENKRON → Product Service event'i alır, stoğu düşürür   │
└──────────────────────────────────────────────────────────────┘
```

**Linux / macOS:**
```bash
curl -s -X POST http://localhost:8081/order/orders \
  -H "Content-Type: application/json" \
  -d "{\"productId\": \"$PRODUCT_ID\", \"quantity\": 3}" | python3 -m json.tool
```

**Windows PowerShell:**
```powershell
$body = @{ productId = $PRODUCT_ID; quantity = 3 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8081/order/orders `
  -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 5
```

**Beklenen cevap:**
```json
{
  "success": true,
  "message": "Sipariş oluşturuldu. Stok asenkron olarak güncellenecek.",
  "data": {
    "id": 1,
    "product_id": "67be3a...",
    "product_name": "Laptop",
    "quantity": 3,
    "unit_price": "25000.00",
    "total_price": "75000.00",
    "status": "created"
  },
  "communication": {
    "sync":  "HTTP GET → Product Service (ürün bilgisi & stok kontrolü)",
    "async": "RabbitMQ → order.created event (stok düşürme)"
  }
}
```

---

### Adım 5: Stoğun Düştüğünü Doğrula (Asenkron Sonucu)

RabbitMQ üzerinden Product Service stoğu **asenkron** olarak düşürdü. 1-2 saniye bekleyip kontrol edin.

**Linux / macOS:**
```bash
sleep 2
curl -s http://localhost:8081/product/products/$PRODUCT_ID | python3 -m json.tool
```

**Windows PowerShell:**
```powershell
Start-Sleep -Seconds 2
Invoke-RestMethod http://localhost:8081/product/products/$PRODUCT_ID | ConvertTo-Json -Depth 5
```

> **stock** değeri 3 azalmış olmalı (50 → **47**)
> Bu, RabbitMQ üzerinden asenkron haberleşmenin çalıştığını kanıtlar.

---

### Adım 6: Yetersiz Stok Testi (Senkron Validasyon)

Order Service, Product Service'e senkron sorgu atarak stok kontrolü yapar. Yetersizse sipariş reddedilir.

**Linux / macOS:**
```bash
curl -s -X POST http://localhost:8081/order/orders \
  -H "Content-Type: application/json" \
  -d "{\"productId\": \"$PRODUCT_ID\", \"quantity\": 9999}" | python3 -m json.tool
```

**Windows PowerShell:**
```powershell
$body = @{ productId = $PRODUCT_ID; quantity = 9999 } | ConvertTo-Json
try {
  Invoke-RestMethod -Method Post -Uri http://localhost:8081/order/orders `
    -ContentType "application/json" -Body $body
} catch {
  $_.ErrorDetails.Message | ConvertFrom-Json | ConvertTo-Json -Depth 5
}
```

**Beklenen cevap:**
```json
{
  "success": false,
  "error": "Yetersiz stok",
  "available": 47,
  "requested": 9999
}
```

---

### Adım 7: Yeni Ürün Ekle

**Linux / macOS:**
```bash
curl -s -X POST http://localhost:8081/product/products \
  -H "Content-Type: application/json" \
  -d '{"name": "Monitor", "price": 5000, "stock": 30, "category": "electronics"}' | python3 -m json.tool
```

**Windows PowerShell:**
```powershell
$body = @{ name = "Monitor"; price = 5000; stock = 30; category = "electronics" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8081/product/products `
  -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 5
```

---

### Adım 8: Siparişleri PostgreSQL'den Listele

**Linux / macOS:**
```bash
curl -s http://localhost:8081/order/orders | python3 -m json.tool
```

**Windows PowerShell:**
```powershell
Invoke-RestMethod http://localhost:8081/order/orders | ConvertTo-Json -Depth 5
```

---

### Adım 9: RabbitMQ Management UI'dan Doğrulama

Tarayıcıda: **http://localhost:15672** (guest / guest)

| Sekme | Ne bakılacak? |
|-------|---------------|
| **Queues** | `product_stock_update` kuyruğunu bulun |
| **Messages** | Ready (bekleyen), Unacked (işlenen), Total |
| **Connections** | product_service ve order_service bağlantılarını görün |
| **Exchanges** | `order_events` (fanout) exchange'ini görün |

---

### Adım 10: Logları İnceleyin

```bash
# Senkron + Asenkron haberleşme logları (her platformda aynı)
docker compose logs order_service | grep -E "SENKRON|ASENKRON"
docker compose logs product_service | grep -E "Event|Stok"
```

**Windows PowerShell alternatifi (grep yoksa):**
```powershell
docker compose logs order_service | Select-String "SENKRON|ASENKRON"
docker compose logs product_service | Select-String "Event|Stok"
```

**Beklenen çıktı:**
```
# ── Order Service (Senkron istek + Asenkron event) ──
SENKRON >> Product Service'e istek: http://product_service:6000/products/...
SENKRON << Ürün bulundu: Laptop (stok: 50)
Sipariş kaydedildi: #1
ASENKRON >> RabbitMQ'ya event gönderiliyor: order.created

# ── Product Service (Asenkron consumer) ──
Event alındı: order.created -> { orderId: 1, productId: '...', quantity: 3 }
Stok güncellendi: Laptop -> yeni stok: 47
```

---

### Adım 11: Consumer Dayanıklılık Testi (Opsiyonel)

Product Service'i durdurun → sipariş oluşturun → tekrar başlatın → stoğun düştüğünü doğrulayın.

```bash
# 1. Product Service'i durdur
docker compose stop product_service

# 2. Doğrudan Order Service'e sipariş gönder (nginx üzerinden gitmez çünkü product çöktü)
#    Bu istek FAIL olacak çünkü senkron kontrol yapılamıyor
#    Bu, senkron haberleşmenin dezavantajını gösterir!

# 3. Product Service'i tekrar başlat
docker compose start product_service

# 4. Kuyrukta bekleyen mesajları kontrol et
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers
```

> Bu test, senkron haberleşmenin **tight coupling** dezavantajını somut olarak gösterir.
> Product Service çöktüğünde sipariş de oluşturulamaz.

---

## Erişim Bilgileri

| Servis | URL | Kullanıcı/Şifre |
|--------|-----|-----------------|
| API Gateway (Nginx) | http://localhost:8081 | - |
| RabbitMQ Management | http://localhost:15672 | guest / guest |
| Prometheus | http://localhost:9090 | - |
| Grafana | http://localhost:3001 | admin / admin |
| MongoDB | localhost:27017 | root / secret |
| PostgreSQL | localhost:5432 | orderuser / orderpass |

---

## Faydalı Komutlar

```bash
# Tüm servisleri başlat
docker compose up -d

# Logları canlı izle
docker compose logs -f

# Sadece belirli servislerin logları
docker compose logs -f product_service order_service

# Servis durumları
docker compose ps

# Tümünü durdur
docker compose down

# Tümünü durdur + verileri sil
docker compose down -v

# Yeniden build et
docker compose build --no-cache && docker compose up -d

# MongoDB'ye bağlan
docker compose exec mongodb mongosh -u root -p secret

# PostgreSQL'e bağlan
docker compose exec postgres psql -U orderuser -d orderdb

# RabbitMQ queue durumu
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers
```

---

## MongoDB Shell (mongosh) Kullanımı

> **Not:** MongoDB'ye tarayıcıdan erişilemez. Port 27017 sadece driver/shell bağlantıları içindir.

```bash
# Bağlan
docker compose exec mongodb mongosh -u root -p secret
```

```javascript
// ── Veritabanı İşlemleri ──
show dbs                          // Tüm veritabanlarını listele
use productdb                     // productdb'ye geç

// ── Koleksiyon İşlemleri ──
show collections                  // Koleksiyonları listele (products)
db.products.countDocuments()      // Kaç ürün var?

// ── Okuma (Read) ──
db.products.find()                // Tüm ürünleri getir
db.products.find().pretty()       // Formatlı göster
db.products.findOne()             // İlk ürünü getir
db.products.find({ category: "electronics" })           // Kategoriye göre filtrele
db.products.find({ price: { $gt: 500 } })               // Fiyatı 500'den büyük
db.products.find({ stock: { $lt: 100 } })               // Stoğu 100'den az
db.products.find({}, { name: 1, stock: 1, _id: 0 })     // Sadece name ve stock alanları

// ── Ekleme (Create) ──
db.products.insertOne({
    name: "Mouse",
    price: 300,
    stock: 80,
    category: "electronics"
})

// ── Güncelleme (Update) ──
db.products.updateOne(
    { name: "Laptop" },                    // Filtre
    { $set: { price: 27000 } }             // Güncelle
)
db.products.updateOne(
    { name: "Laptop" },
    { $inc: { stock: -5 } }                // Stoğu 5 azalt
)

// ── Silme (Delete) ──
db.products.deleteOne({ name: "Mouse" })   // Tek kayıt sil

// ── Aggregation (İleri seviye) ──
db.products.aggregate([
    { $group: {
        _id: "$category",
        totalStock: { $sum: "$stock" },
        avgPrice: { $avg: "$price" },
        count: { $sum: 1 }
    }}
])
// → Her kategori için toplam stok, ortalama fiyat ve ürün sayısı

// ── Çıkış ──
exit
```

### MongoDB vs SQL Karşılaştırması

| SQL (PostgreSQL) | MongoDB (mongosh) |
|------------------|-------------------|
| `SELECT * FROM products` | `db.products.find()` |
| `SELECT name, price FROM products` | `db.products.find({}, {name:1, price:1})` |
| `SELECT * FROM products WHERE price > 500` | `db.products.find({price: {$gt: 500}})` |
| `INSERT INTO products (name, price) VALUES ('X', 100)` | `db.products.insertOne({name:'X', price:100})` |
| `UPDATE products SET stock=10 WHERE name='X'` | `db.products.updateOne({name:'X'}, {$set:{stock:10}})` |
| `DELETE FROM products WHERE name='X'` | `db.products.deleteOne({name:'X'})` |
| `SELECT category, COUNT(*) FROM products GROUP BY category` | `db.products.aggregate([{$group:{_id:"$category", count:{$sum:1}}}])` |

---

## PostgreSQL Shell (psql) Kullanımı

> **Not:** PostgreSQL'e de tarayıcıdan erişilemez. Port 5432 sadece driver/shell bağlantıları içindir.

```bash
# Bağlan
docker compose exec postgres psql -U orderuser -d orderdb
```

```sql
-- ── Meta Komutlar (psql'e özel, SQL değil) ──
\l                              -- Tüm veritabanlarını listele
\dt                             -- Tabloları listele
\d orders                       -- orders tablosunun yapısını göster
\x                              -- Genişletilmiş (dikey) görünüm aç/kapat

-- ── Okuma (Read) ──
SELECT * FROM orders;                                    -- Tüm siparişler
SELECT * FROM orders ORDER BY created_at DESC LIMIT 5;   -- Son 5 sipariş
SELECT * FROM orders WHERE status = 'created';           -- Duruma göre filtrele
SELECT * FROM orders WHERE total_price > 1000;           -- Tutara göre filtrele
SELECT id, product_name, quantity, total_price FROM orders;  -- Belirli sütunlar

-- ── Toplam/İstatistik ──
SELECT COUNT(*) FROM orders;                             -- Toplam sipariş sayısı
SELECT SUM(total_price) AS toplam_ciro FROM orders;      -- Toplam ciro
SELECT AVG(total_price) AS ortalama FROM orders;         -- Ortalama sipariş tutarı
SELECT product_name, COUNT(*) as siparis_sayisi, SUM(quantity) as toplam_adet
    FROM orders
    GROUP BY product_name
    ORDER BY siparis_sayisi DESC;                        -- Ürün bazlı özet

-- ── Ekleme (Create) ──
INSERT INTO orders (product_id, product_name, quantity, unit_price, total_price, status)
VALUES ('abc123', 'Test Ürün', 1, 100.00, 100.00, 'created');

-- ── Güncelleme (Update) ──
UPDATE orders SET status = 'completed' WHERE id = 1;

-- ── Silme (Delete) ──
DELETE FROM orders WHERE id = 1;

-- ── Tablo Yapısı ──
-- CHECK constraint'i test et (quantity 0 veya negatif olamaz)
INSERT INTO orders (product_id, quantity) VALUES ('x', -1);
-- → ERROR: new row violates check constraint "orders_quantity_check"

-- ── Çıkış ──
\q
```

---

## RabbitMQ Yönetimi

### Web UI (Tarayıcıdan)
**http://localhost:15672** (guest / guest)

Önemli sekmeler:
- **Overview** → Mesaj hızı, bağlantı sayısı
- **Connections** → Hangi servisler bağlı?
- **Channels** → Açık kanallar (producer + consumer)
- **Exchanges** → `order_events` exchange'ini görün
- **Queues** → `product_stock_update` kuyruğunu görün
  - Ready: İşlenmeyi bekleyen mesajlar
  - Unacked: Consumer aldı ama henüz ACK göndermedi
  - Total: Toplam

### Terminal'den

```bash
# Kuyruk durumları (isim, bekleyen mesaj, consumer sayısı)
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers

# Exchange'leri listele
docker compose exec rabbitmq rabbitmqctl list_exchanges name type

# Bağlantıları listele
docker compose exec rabbitmq rabbitmqctl list_connections user peer_host state

# Consumer'ları listele
docker compose exec rabbitmq rabbitmqctl list_consumers
```
