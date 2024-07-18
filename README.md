# DHT Prometheus

A bridge to scrape Prometheus metrics from self-registering services, all using direct, end-to-end encrypted peer-to-peer connections.

Its main advantage is that it does not use http: service discovery is done with a decentralised hash table ([HyperDHT](https://github.com/holepunchto/hyperdht)). This means that both this service and the clients it scrapes can live behind a firewall and need no reverse proy nor DNS entries.

Another advantage is the small amount of configuration required. [Clients](https://gitlab.com/dcent-tech/dht-prom-client) register themselves with the DHT-Prometheus service, so no manual list of targets needs to be maintained. All a client needs to register itself, is the DHT-Prometheus service's public key, and a shared secret.

## Deployment

DHT-Prometheus is meant to be deployed alongside Prometheus. It manages a single `targets.json` file referenced from the main prometheus configuration (See [prometheus/prometheus.yml](prometheus/prometheus.yml) for an example).

The DHT-prometheus service fulfils two complementary roles:
 - It maintains a `targets.json` file with aliases to all services which Prometheus should scrape.
 - It provides an HTTP server which receives Prometheus requests and forwards them to the DHT-prom clients.

### Run

#### Docker

```
docker run --network host --env DHT_PROM_SHARED_SECRET=<A 64 character hex string> --mount type=bind,source=/etc/prometheus/config/prometheus-dht-targets,destination=/home/dht-prometheus/prometheus
```

The intent is for the prometheus service to read its config from a read-only bind mount to `/etc/prometheus/config`, and for its config file to reference `./prometheus-dht-targets/targets.json`

Note: `/etc/prometheus/config/prometheus-dht-targets` should be writable by the container's user.

#### CLI

```
DHT_PROM_PROMETHEUS_TARGETS_LOC=path/to/prometheus/targets.json DHT_PROM_HTTP_PORT=30000 DHT_PROM_SHARED_SECRET=<A 64 character hex string> dht-prometheus
```

## Install

```
npm i dht-prometheus
```

## Test

Note: the tests run [./prep-integration-test.sh](./prep-integration-test.sh), which downloads Prometheus and copies the executable to the ./prometheus directory.

```
npm test
```
