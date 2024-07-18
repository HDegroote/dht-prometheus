#! /bin/bash
# TODO: make robust

set -e # Exit immediately on any unexpected error

echo "Preparing integration test (ensuring Prometheus is downloaded)"

PROMETHEUS_VERSION="2.53.1"
# Assumes Linux intel--change for ARM or mac (https://prometheus.io/download/)
OWN_OS="linux-amd64"
TARGET_LOC=./prometheus/prometheus

if test -f "$TARGET_LOC"; then
  echo "Success: Prometheus is already installed (exiting)"
  exit 0
fi

echo "Prometheus is not yet installed"

# E.g. https://github.com/prometheus/prometheus/releases/download/v2.53.1/prometheus-2.53.1.linux-amd64.tar.gz
URL="https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.${OWN_OS}.tar.gz"
echo "Downloading Prometheus from ${URL}"

wget -O ./prometheus.tar.gz $URL

tar -xf prometheus.tar.gz

cp "./prometheus-${PROMETHEUS_VERSION}.${OWN_OS}/prometheus" ./prometheus/prometheus

echo "Successfully prepared integration test (Prometheus downloaded and setup)"
