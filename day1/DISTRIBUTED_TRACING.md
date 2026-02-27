# Distributed Tracing (Dağıtık İzleme)

## Mikroservislerde Neden İzleme Gerekiyor?

Monolitik bir uygulamada bir hata olduğunda tek bir log dosyasına bakarsınız, çağrı yığınını (stack trace) görürsünüz ve sorunu bulursunuz.

Ama mikroservislerde bir kullanıcı isteği **birden fazla servisten** geçer. Bizim projemizde sipariş oluşturma akışı şöyle:

```
Kullanıcı
   │
   ▼
┌────────┐   HTTP    ┌─────────────────┐   HTTP    ┌─────────────────┐
│ Nginx  │ ────────→ │ Order Service   │ ────────→ │ Product Service │
└────────┘           │ (Node.js)       │           │ (Node.js)       │
                     └────────┬────────┘           └─────────────────┘
                              │                           |
                              │ RabbitMQ                  │ RabbitMQ
                              │ (order.created)           │ (order.created)
                              ▼                           │
                     ┌─────────────────┐                  │
                     │ Mail Service    │    Aynı event ───┘
                     │ (.NET)          │    (fanout exchange)
                     └─────────────────┘
```

Bir sipariş oluşturduğunuzda:
1. **Order Service** – Ürün bilgisini almak için Product Service'e HTTP isteği atar (senkron)
2. **Order Service** – Siparişi PostgreSQL'e kaydeder
3. **Order Service** – `order.created` event'ini RabbitMQ'ya gönderir (asenkron)
4. **Product Service** – Event'i alır, stok düşürür (MongoDB)
5. **Mail Service** – Event'i alır, bildirim maili gönderir

**Problem:** Bir şey ters gittiğinde hangi serviste, hangi adımda, ne kadar sürede hata oldu? 3 farklı servisin loglarını mı karıştıracaksınız?

**Çözüm:** Distributed Tracing. Tek bir Trace ID ile isteğin tüm servisler boyunca yolculuğunu takip edin.

---

## Temel Kavramlar

### Trace
Bir kullanıcı isteğinin **tüm yolculuğu**. Baştan sona, hangi servise girdi, ne yaptı, ne kadar sürdü — hepsi tek bir `traceId` altında.

### Span
Bir trace içindeki **tek bir iş birimi**. Örneğin:
- `POST /orders` → bir span
- `GET /products/:id` → bir span  
- `pg.query:INSERT` → bir span
- `publish order.created` → bir span
- `consume order.created` → bir span

Her span şu bilgileri taşır:
- Operasyon adı
- Başlangıç ve bitiş zamanı (süre)
- Hangi servise ait
- Parent span (bu span'i kim tetikledi?)

### Trace Context (W3C Traceparent)
Servisler arası **trace bilgisini taşıyan** standart header:

```
traceparent: 00-288cdc3f8ec01490aa083e18458282c2-1c168cf939efc875-01
              │  │                                │                │
              │  │                                │                └─ flags (01 = sampled)
              │  │                                └─ parent span id (8 byte hex)
              │  └─ trace id (16 byte hex) ← TÜM SERVİSLERDE AYNI
              └─ version
```

Bu header sayesinde farklı servislerdeki span'ler aynı trace'e bağlanır.

---

## Kullandığımız Araçlar

| Araç | Görevi |
|------|--------|
| **OpenTelemetry** | Trace verisi üretir ve gönderir (SDK) |
| **Jaeger** | Trace verilerini toplar, saklar ve görselleştirir (Backend + UI) |
| **OTLP** | OpenTelemetry'nin veri gönderim protokolü (HTTP/gRPC) |

**OpenTelemetry** endüstri standardıdır. Vendor-agnostic'tir — Jaeger, Zipkin, Datadog, New Relic... istediğiniz backend'e gönderebilirsiniz. Kodunuzu değiştirmezsiniz, sadece exporter'ı değiştirirsiniz.

---

## Mimari

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Product    │     │    Order     │     │     Mail     │
│   Service    │     │   Service    │     │   Service    │
│  (Node.js)   │     │  (Node.js)   │     │   (.NET)     │
│              │     │              │     │              │
│ OpenTelemetry│     │ OpenTelemetry│     │ OpenTelemetry│
│     SDK      │     │     SDK      │     │     SDK      │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │    OTLP/HTTP       │   OTLP/HTTP        │   OTLP/HTTP
       └────────────────────┼────────────────────┘
                            ▼
                    ┌───────────────┐
                    │    Jaeger     │
                    │  (Collector)  │
                    │   Port 4318   │
                    │               │
                    │   Jaeger UI   │
                    │  Port 16686   │
                    └───────────────┘
```

Her servis, OpenTelemetry SDK'sı aracılığıyla span verilerini OTLP/HTTP protokolüyle Jaeger'a gönderir. Jaeger bunları toplar ve web arayüzünde gösterir.

---

## Nginx'te Trace Header Yönlendirmesi

Nginx reverse proxy olduğu için, gelen `traceparent` header'ını backend servislere iletmesi gerekir:

```nginx
location /order/ {
    proxy_pass http://backend_order/;
    proxy_set_header traceparent $http_traceparent;
    proxy_set_header tracestate  $http_tracestate;
}
```

Bu olmazsa, Nginx trace zincirini kırar ve her servis bağımsız bir trace başlatır.

---

## RabbitMQ Üzerinden Trace Propagation

HTTP iletişiminde trace context **otomatik** taşınır — OpenTelemetry SDK'sı `traceparent` header'ını giden HTTP isteklerine otomatik ekler.

Ama **RabbitMQ asenkron mesajlaşma** farklıdır. Mesaj kuyruğu üzerinden trace context otomatik taşınmaz. Bunu **elle** yapmamız gerekir.

### Neden?

```
Order Service ──HTTP──→ Product Service     ← OTel otomatik traceparent ekler ✓
Order Service ──MQ────→ Product Service     ← Kim ekleyecek? Biz eklemeliyiz!
Order Service ──MQ────→ Mail Service        ← Kim ekleyecek? Biz eklemeliyiz!
```

### Producer Tarafı (Order Service — mesajı gönderen)

```javascript
const { trace, context, propagation, SpanKind } = require('@opentelemetry/api');

function publishEvent(eventName, data) {
    const tracer = trace.getTracer('order-service');

    // 1. PRODUCER tipi span oluştur
    const span = tracer.startSpan(`publish ${eventName}`, {
        kind: SpanKind.PRODUCER,
        attributes: {
            'messaging.system': 'rabbitmq',
            'messaging.destination': 'order_events',
            'messaging.operation': 'publish',
        },
    });

    // 2. Trace context'i bir headers objsine enjekte et
    const headers = {};
    propagation.inject(trace.setSpan(context.active(), span), headers);
    // headers artık şunu içerir:
    // { traceparent: "00-abc123...-def456...-01" }

    // 3. RabbitMQ mesajına bu header'ları ekle
    rabbitChannel.publish('order_events', '', Buffer.from(JSON.stringify(data)), {
        headers: headers,     // ← trace context burada taşınıyor
        persistent: true,
    });

    span.end();
}
```

Ne yaptık?
1. Bir PRODUCER span başlattık (mesajı gönderdik)
2. `propagation.inject()` ile trace context'i bir JS objesine yazdık
3. Bu objeyi RabbitMQ mesajının `headers` alanına koyduk

### Consumer Tarafı — Node.js (Product Service)

Node.js'te `@opentelemetry/auto-instrumentations-node` paketi, amqplib kütüphanesini otomatik olarak izler. Yani RabbitMQ consumer'da **ekstra kod yazmamıza gerek yoktur** — gelen mesajdaki `traceparent` header'ı otomatik okunur ve span oluşturulur.

### Consumer Tarafı — .NET (Mail Service)

.NET'te RabbitMQ client'ı için otomatik instrumentation olmadığından, trace context'i **elle** çıkarmamız gerekir:

---
## Hands-On: Sipariş Oluştur ve İzle

> **Not:** Aşağıdaki komutlar 3 formatta verilmiştir:
> - **Bash** — macOS / Linux terminali
> - **PowerShell** — Windows terminali
> - **Postman** — GUI tercih edenler için
>
> Size uygun olanı kullanın. Postman yerine **Insomnia**, **Bruno** veya **Thunder Client** (VS Code eklentisi) de kullanabilirsiniz.

### Ön Koşul: Sistemi Ayağa Kaldırın

```bash
docker compose up -d --build
```

Servislerin hazır olduğunu doğrulayın:

**Bash:**
```bash
curl -s http://localhost:8081/product/health | python3 -m json.tool
curl -s http://localhost:8081/order/health | python3 -m json.tool
curl -s http://localhost:8081/mail/health | python3 -m json.tool
```

**PowerShell:**
```powershell
Invoke-RestMethod http://localhost:8081/product/health
Invoke-RestMethod http://localhost:8081/order/health
Invoke-RestMethod http://localhost:8081/mail/health
```

**Postman:**
| # | Method | URL |
|---|--------|-----|
| 1 | GET | `http://localhost:8081/product/health` |
| 2 | GET | `http://localhost:8081/order/health` |
| 3 | GET | `http://localhost:8081/mail/health` |

Her üçünden de `"status": "ok"` yanıtı gelmelidir.

### Adım 1: Mevcut Ürünleri Listele

Sipariş oluşturmak için bir ürün ID'sine ihtiyacımız var:

**Bash:**
```bash
curl -s http://localhost:8081/product/products | python3 -m json.tool
```

**PowerShell:**
```powershell
Invoke-RestMethod http://localhost:8081/product/products | ConvertTo-Json -Depth 5
```

**Postman:**
- **GET** `http://localhost:8081/product/products` → Send

Çıktıdan bir ürünün `_id` değerini kopyalayın. Örnek:

```json
{
    "_id": "699f3ec1692a217ffce3df54",
    "name": "Kulaklık",
    "price": 500,
    "stock": 200
}
```

### Adım 2: Sipariş Oluştur

**Bash:**
```bash
curl -s -X POST http://localhost:8081/order/orders \
  -H "Content-Type: application/json" \
  -d '{"productId": "BURAYA_URUN_ID", "quantity": 2}' | python3 -m json.tool
```

**PowerShell:**
```powershell
$body = @{ productId = "BURAYA_URUN_ID"; quantity = 2 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8081/order/orders `
  -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 5
```

**Postman:**
- **POST** `http://localhost:8081/order/orders`
- **Body** → raw → JSON:
```json
{
  "productId": "BURAYA_URUN_ID",
  "quantity": 2
}
```

Beklenen çıktı:

```json
{
    "success": true,
    "message": "Sipariş oluşturuldu. Stok asenkron olarak güncellenecek.",
    "data": {
        "id": 1,
        "product_name": "Kulaklık",
        "quantity": 2,
        "total_price": "1000.00",
        "status": "created"
    },
    "communication": {
        "sync": "HTTP GET → Product Service (ürün bilgisi & stok kontrolü)",
        "async": "RabbitMQ → order.created event (stok düşürme)"
    }
}
```

Bu tek istek arka planda 3 servisi tetikledi:
1. Order → Product (HTTP senkron — ürün bilgisi)
2. Order → RabbitMQ → Product (asenkron — stok düşürme)
3. Order → RabbitMQ → Mail (asenkron — bildirim maili)

### Adım 3: Jaeger UI'ı Açın

Tarayıcınızda açın: **http://localhost:16686**

### Adım 4: Trace'i Bulun

1. Sol panelde **Service** dropdown'ından `order-service` seçin
2. **Operation** dropdown'ından `POST /orders` seçin
3. **Find Traces** butonuna tıklayın
4. En üstteki (en yeni) trace'e tıklayın

### Adım 5: Trace'i Okuyun

Şuna benzer bir görüntü göreceksiniz:

```
order-service    POST /orders                          ████████████████████  45ms
  order-service    GET /products/699f3ec...             ████████████         28ms
    product-service  GET /products/699f3ec...           ██████████           22ms
      product-service  mongoose.Product.findOne         ████                  8ms
        product-service  mongodb.find                   ██                    3ms
  order-service    pg.query:INSERT orderdb              ████                  6ms
  order-service    publish order.created                █                     2ms
    product-service  product_stock_update process       ████████             15ms
      product-service  mongoose.Product.findOne         ████                  5ms
        product-service  mongodb.find                   ██                    2ms
      product-service  mongoose.Product.save            ████                  4ms
        product-service  mongodb.update                 ██                    2ms
    mail-service     consume order.created              ██                    3ms
```

**Bu trace'den okuduklarımız:**

| #   | Span                                        | Servis                          | Açıklama                                 |
| --- | ------------------------------------------- | ------------------------------- | ---------------------------------------- |
| 1   | `POST /orders`                              | order-service                   | Kullanıcının isteği başladı              |
| 2   | `GET /products/:id`                         | order-service → product-service | **Senkron** HTTP ile ürün bilgisi alındı |
| 3   | `mongoose.Product.findOne` → `mongodb.find` | product-service                 | MongoDB'den ürün sorgulandı              |
| 4   | `pg.query:INSERT`                           | order-service                   | Sipariş PostgreSQL'e kaydedildi          |
| 5   | `publish order.created`                     | order-service                   | RabbitMQ'ya event gönderildi             |
| 6   | `product_stock_update process`              | product-service                 | **Asenkron** olarak stok düşürüldü       |
| 7   | `consume order.created`                     | mail-service                    | **Asenkron** olarak mail gönderildi      |


### Adım 6: Süreleri İnceleyin

Her span'in yanındaki çubuk, o operasyonun süresini gösterir. Şunlara dikkat edin:

- **En uzun span hangisi?** → Darboğaz (bottleneck) burada
- **Senkron vs asenkron fark** → `POST /orders` span'i, `publish order.created` biter bitmez kapanır. Stok güncelleme ve mail gönderimi arka planda devam eder
- **DB sorgularının süresi** → `mongodb.find`, `pg.query:INSERT` ne kadar sürüyor?

## Hata Senaryoları — Tracing'in Gerçek Gücü

### Senaryo A: Senkron Hata — Olmayan Ürün (404)

Olmayan bir ürün ID'si ile sipariş deneyin:

**Bash:**
```bash
curl -s -X POST http://localhost:8081/order/orders \
  -H "Content-Type: application/json" \
  -d '{"productId": "000000000000000000000000", "quantity": 1}' | python3 -m json.tool
```

**PowerShell:**
```powershell
$body = @{ productId = "000000000000000000000000"; quantity = 1 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8081/order/orders `
  -ContentType "application/json" -Body $body
```

**Postman:**
- **POST** `http://localhost:8081/order/orders`
- **Body** → raw → JSON:
```json
{
  "productId": "000000000000000000000000",
  "quantity": 1
}
```

Yanıt:
```json
{
    "success": false,
    "error": "Ürün bulunamadı",
    "productId": "000000000000000000000000"
}
```

**Jaeger'da bu trace'i bulun.** Hatalı span'ler **kırmızı** ile işaretlenir:

```
order-service    POST /orders                     ████████ ❌ 404
 
```

**Gözlem:** Hata senkrondur. İstek chain'i boyunca her yerde 404 görürsünüz. Sorunun nereden kaynaklandığı açıktır — en içteki span'de MongoDB sorgusu sonuç döndürmemiş.

RabbitMQ'ya event **gönderilmemiştir** çünkü sipariş oluşturulmadı. Sadece senkron kısım etkilenmiş.

---

### Senaryo B: Asenkron Hata — Race Condition ⚠️

Bu senaryo tracing'in neden kritik olduğunu gösterir. **Kullanıcıya "başarılı" yanıt dönmüş ama arka planda işlem patlamış** durumunu yakalayacağız.

**Hatırlayın:** Sipariş akışımızda stok kontrolü **senkron** (HTTP GET ile Product Service'e sorulur), ama stok düşürme **asenkron** (RabbitMQ event ile). Bu iki adım arasında bir zaman farkı var.

**Adım B1: Stok seviyesini düşük bir değere ayarlayın**

Önce ürün listesinden Laptop'un `_id` değerini bulun (Adım 1'deki gibi). Sonra stoğunu 10 yapın:

**Bash:**
```bash
curl -s -X PUT "http://localhost:8081/product/products/LAPTOP_ID_BURAYA/stock" \
  -H "Content-Type: application/json" \
  -d '{"stock": 10}' | python3 -m json.tool
```

**PowerShell:**
```powershell
$body = @{ stock = 10 } | ConvertTo-Json
Invoke-RestMethod -Method Put `
  -Uri http://localhost:8081/product/products/LAPTOP_ID_BURAYA/stock `
  -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 5
```

**Postman:**
- **PUT** `http://localhost:8081/product/products/LAPTOP_ID_BURAYA/stock`
- **Body** → raw → JSON:
```json
{
  "stock": 10
}
```

**Adım B2: Aynı anda 2 sipariş gönderin (her biri 8 adet)**

Önemli olan iki isteğin **neredeyse aynı anda** gönderilmesidir. İlk isteğin asenkron stok düşürmesi tamamlanmadan ikincisi de senkron kontrolden geçmelidir.

**Bash:**
```bash
curl -s -X POST http://localhost:8081/order/orders \
  -H "Content-Type: application/json" \
  -d '{"productId": "LAPTOP_ID_BURAYA", "quantity": 8}' &

curl -s -X POST http://localhost:8081/order/orders \
  -H "Content-Type: application/json" \
  -d '{"productId": "LAPTOP_ID_BURAYA", "quantity": 8}' &

wait
echo "İki sipariş gönderildi!"
```

**PowerShell:**
```powershell
$body = @{ productId = "LAPTOP_ID_BURAYA"; quantity = 8 } | ConvertTo-Json

# İki isteği paralel başlat
$job1 = Start-Job {
    Invoke-RestMethod -Method Post -Uri http://localhost:8081/order/orders `
      -ContentType "application/json" -Body $using:body
}
$job2 = Start-Job {
    Invoke-RestMethod -Method Post -Uri http://localhost:8081/order/orders `
      -ContentType "application/json" -Body $using:body
}

# Bekle ve sonuçları göster
$job1, $job2 | Wait-Job | Receive-Job
Write-Host "İki sipariş gönderildi!"
```

**Postman:**
1. Bir **POST** `http://localhost:8081/order/orders` isteği hazırlayın:
   ```json
   { "productId": "LAPTOP_ID_BURAYA", "quantity": 8 }
   ```
2. Postman'de **iki ayrı tab** açın, aynı isteği yapıştırın
3. İlk tab'da **Send** tıklayın, hemen ardından ikinci tab'da da **Send** tıklayın
4. (Veya Postman **Runner** ile aynı collection'ı 2 iteration paralel çalıştırın)

**Ne oldu?**

| Adım | Sipariş A | Sipariş B |
|------|-----------|-----------|
| 1. Senkron stok kontrolü | Stok: 10, İstenen: 8 → ✅ Geçti | Stok: 10, İstenen: 8 → ✅ Geçti |
| 2. DB'ye kaydet | ✅ Sipariş oluşturuldu | ✅ Sipariş oluşturuldu |
| 3. Kullanıcıya yanıt | ✅ "Başarılı" | ✅ "Başarılı" |
| 4. Asenkron stok düşür | 10 → 2 ✅ | 2 - 8 = -6 → ❌ **Yetersiz stok!** |

Her iki sipariş de senkron kontrolden geçti çünkü **ikisi de stoku 10 olarak gördü** — henüz hiçbiri asenkron olarak düşürülmemişti.

**Adım B3: Sonuçları kontrol edin**

**Bash:**
```bash
curl -s http://localhost:8081/product/products | python3 -m json.tool
docker compose logs product_service --tail=10 | grep -E "güncellendi|❌|Yetersiz"
```

**PowerShell:**
```powershell
(Invoke-RestMethod http://localhost:8081/product/products).data | Where-Object { $_.name -eq "Laptop" } | Select-Object name, stock
docker compose logs product_service --tail=10 | Select-String "güncellendi|Yetersiz"
```

**Postman:**
- **GET** `http://localhost:8081/product/products` → Yanıtta Laptop'un `stock` değerini kontrol edin

Beklenen çıktı:
```
Laptop stok: 2
[xxxx] Stok güncellendi: Laptop -> yeni stok: 2
[xxxx] ❌ Stok güncelleme hatası: Yetersiz stok! Ürün: Laptop, Mevcut: 2, İstenen: 8
```

**Adım B4: Jaeger'da trace'leri karşılaştırın**

1. Jaeger UI'da **order-service** → **POST /orders** trace'lerini bulun
2. İki trace göreceksiniz — ikisi de 3 servisi içerir (order, product, mail)
3. Birinde `product_stock_update process` span'i **yeşil** (başarılı stok düşürme)
4. Diğerinde aynı span **kırmızı** (hata!)

Kırmızı span'e tıklayın. `Tags` bölümünde:
```
otel.status_code = ERROR
error = true
exception.message = Yetersiz stok! Ürün: Laptop, Mevcut: 2, İstenen: 8
```

**Kritik Çıkarım:**

> Kullanıcı iki kez "sipariş başarılı" yanıtı almıştır. Hiçbir HTTP isteği hata dönmemiştir. Ama arka planda ikinci siparişin stok güncellemesi **sessizce** başarısız olmuştur.
>
> **Log'lara bakmasanız veya trace kullanmasanız bunu farkedemezsiniz.**
>
> İşte distributed tracing'in gerçek değeri budur — asenkron akışlardaki gizli hataları görünür kılar.

**Bu örnek aynı zamanda bir tasarım sorununu da gösterir:** Senkron stok kontrolü ile asenkron stok güncelleme arasındaki race condition.

---

### Adım 8: Stoku Sıfırlayın

Test sonrası Laptop stoğunu eski haline getirin:

**Bash:**
```bash
curl -s -X PUT "http://localhost:8081/product/products/LAPTOP_ID_BURAYA/stock" \
  -H "Content-Type: application/json" \
  -d '{"stock": 50}' | python3 -m json.tool
```

**PowerShell:**
```powershell
$body = @{ stock = 50 } | ConvertTo-Json
Invoke-RestMethod -Method Put `
  -Uri http://localhost:8081/product/products/LAPTOP_ID_BURAYA/stock `
  -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 5
```

**Postman:**
- **PUT** `http://localhost:8081/product/products/LAPTOP_ID_BURAYA/stock`
- **Body** → raw → JSON:
```json
{
  "stock": 50
}
```
