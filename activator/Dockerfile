FROM golang:1.24-alpine AS build
WORKDIR /src
ENV GOTOOLCHAIN=local CGO_ENABLED=0
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -ldflags=-s -o /activator ./cmd/activator

FROM alpine:3.22
COPY --from=build /activator /usr/local/bin/activator
COPY activator.yaml /etc/activator.yaml
EXPOSE 8080 8081 8090
ENTRYPOINT ["activator", "-config", "/etc/activator.yaml"]
