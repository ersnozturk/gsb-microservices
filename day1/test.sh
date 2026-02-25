
seq 1 10000 | xargs -P 1000 -I {} curl -s http://localhost:8081/order/ > /dev/null

seq 1 10000 | xargs -P 1000 -I {} curl -s http://localhost:8081/product/ > /dev/null
