FROM node:20-slim
RUN apt update && apt install curl -y

RUN useradd --create-home -u 4820 dht-prometheus

# Should not be changed (target loc of a volume)
ENV DHT_PROM_PROMETHEUS_TARGETS_LOC=/home/dht-prometheus/prometheus/targets.json

COPY package-lock.json /home/dht-prometheus/
COPY node_modules /home/dht-prometheus/node_modules
COPY package.json /home/dht-prometheus/
COPY run.js /home/dht-prometheus/
COPY index.js /home/dht-prometheus/
COPY LICENSE /home/dht-prometheus/
COPY NOTICE /home/dht-prometheus/
COPY lib /home/dht-prometheus/lib

USER dht-prometheus

RUN mkdir /home/dht-prometheus/prometheus

WORKDIR /home/dht-prometheus

ENTRYPOINT ["node", "/home/dht-prometheus/run.js"]
