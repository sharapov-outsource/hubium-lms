# A server of the lab (e2e/lab): Ubuntu 24.04 with Docker Engine, as the cloud's or a
# branch's server would be, run as a privileged container with Docker inside. Hubium is
# installed on it with install-hubium.sh; iptables and tc cut and slow its line.
FROM docker:29-dind AS docker

FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl openssl iptables iproute2 procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/ /usr/local/bin/
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
# no TLS for the inner daemon: only the server itself talks to it
ENV DOCKER_TLS_CERTDIR=""
VOLUME /var/lib/docker
ENTRYPOINT ["dockerd-entrypoint.sh"]
