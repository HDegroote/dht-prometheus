# (WIP) DHT Prometheus

Bridge to scrape Prometheus metrics exposed by [dht-prom-client](https://gitlab.com/dcent-tech/dht-prom-client), by mapping http requests to protomux-rpc requests.

## Test

Note: the tests run [./prep-integration-test.sh](./prep-integration-test.sh), which downloads Prometheus and copies the executable to the ./prometheus directory.

```
npm test
```
