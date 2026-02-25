
( seq 1 10000 | xargs -P 5 -I {} curl http://localhost:8081/js_container2/ ) &
( seq 1 10000 | xargs -P 5 -I {} curl http://localhost:8081/js_container/ ) &
wait
