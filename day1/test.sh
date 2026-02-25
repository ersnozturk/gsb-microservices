
seq 1 10000 | xargs -P 1000 -I {} curl http://localhost:8081/order/

seq 1 10000 | xargs -P 1000 -I {} curl http://localhost:8081/product/
