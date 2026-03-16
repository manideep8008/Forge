FROM golang:1.23-alpine AS builder

WORKDIR /app

COPY go.mod ./
COPY . .
RUN GONOSUMCHECK=* GOFLAGS=-mod=mod go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o /forge-docker-svc .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates docker-cli
COPY --from=builder /forge-docker-svc /forge-docker-svc

EXPOSE 8082

CMD ["/forge-docker-svc"]
