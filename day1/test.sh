#!/bin/bash
# ========================================
# Microservices Test Script
# ========================================
# Kullanım: ./test.sh
#
# Nginx API Gateway üzerinden test eder:
#   /product/* → Product Service (MongoDB)
#   /order/*   → Order Service (PostgreSQL)
# ========================================

BASE_URL="http://localhost:8081"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo "========================================"
echo "  MICROSERVICES TEST"
echo "========================================"

# ── 1) Ürünleri Listele ──
echo -e "\n${CYAN}[1] GET /product/products - Tüm ürünleri listele${NC}"
PRODUCTS=$(curl -s ${BASE_URL}/product/products)
echo "$PRODUCTS" | head -c 500
echo ""

# İlk ürünün ID'sini al
PRODUCT_ID=$(echo "$PRODUCTS" | grep -o '"_id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo -e "${YELLOW}   → İlk ürün ID: ${PRODUCT_ID}${NC}"

# ── 2) Tek Ürün Detayı ──
echo -e "\n${CYAN}[2] GET /product/products/${PRODUCT_ID} - Ürün detayı${NC}"
curl -s ${BASE_URL}/product/products/${PRODUCT_ID} | python3 -m json.tool 2>/dev/null || curl -s ${BASE_URL}/product/products/${PRODUCT_ID}
echo ""

# ── 3) Yeni Ürün Ekle ──
echo -e "\n${CYAN}[3] POST /product/products - Yeni ürün ekle${NC}"
NEW_PRODUCT=$(curl -s -X POST ${BASE_URL}/product/products \
  -H "Content-Type: application/json" \
  -d '{"name": "Monitor", "price": 5000, "stock": 30, "category": "electronics"}')
echo "$NEW_PRODUCT" | python3 -m json.tool 2>/dev/null || echo "$NEW_PRODUCT"
echo ""

# ── 4) Sipariş Oluştur (SENKRON + ASENKRON haberleşme) ──
echo -e "\n${CYAN}[4] POST /order/orders - Sipariş oluştur${NC}"
echo -e "${YELLOW}   → SENKRON:  Order Service → HTTP GET → Product Service (stok kontrol)${NC}"
echo -e "${YELLOW}   → ASENKRON: Order Service → RabbitMQ → Product Service (stok düşür)${NC}"
ORDER=$(curl -s -X POST ${BASE_URL}/order/orders \
  -H "Content-Type: application/json" \
  -d "{\"productId\": \"${PRODUCT_ID}\", \"quantity\": 2}")
echo "$ORDER" | python3 -m json.tool 2>/dev/null || echo "$ORDER"
echo ""

# ── 5) Siparişleri Listele ──
echo -e "\n${CYAN}[5] GET /order/orders - Tüm siparişleri listele${NC}"
curl -s ${BASE_URL}/order/orders | python3 -m json.tool 2>/dev/null || curl -s ${BASE_URL}/order/orders
echo ""

# ── 6) Stok Kontrolü - Ürünün stoğu düştü mü? ──
echo -e "\n${CYAN}[6] GET /product/products/${PRODUCT_ID} - Stok düştü mü kontrol et${NC}"
echo -e "${YELLOW}   → RabbitMQ event'i ile stok asenkron olarak düşmüş olmalı${NC}"
sleep 2  # Asenkron işlem için kısa bekleme
curl -s ${BASE_URL}/product/products/${PRODUCT_ID} | python3 -m json.tool 2>/dev/null || curl -s ${BASE_URL}/product/products/${PRODUCT_ID}
echo ""

# ── 7) Yetersiz stok testi ──
echo -e "\n${CYAN}[7] POST /order/orders - Yetersiz stok testi (9999 adet)${NC}"
curl -s -X POST ${BASE_URL}/order/orders \
  -H "Content-Type: application/json" \
  -d "{\"productId\": \"${PRODUCT_ID}\", \"quantity\": 9999}" | python3 -m json.tool 2>/dev/null
echo ""

echo -e "\n${GREEN}========================================"
echo "  TEST TAMAMLANDI"
echo -e "========================================${NC}"
echo ""
echo "Servisler:"
echo "  API Gateway:  http://localhost:8081"
echo "  RabbitMQ UI:  http://localhost:15672 (guest/guest)"
echo "  Prometheus:   http://localhost:9090"
echo "  Grafana:      http://localhost:3001 (admin/admin)"
echo ""
