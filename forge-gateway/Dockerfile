FROM golang:1.23-alpine AS builder

WORKDIR /app

COPY go.mod ./
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o /forge-gateway .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
COPY --from=builder /forge-gateway /forge-gateway

EXPOSE 8080

CMD ["/forge-gateway"]
