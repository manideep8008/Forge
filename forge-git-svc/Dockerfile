FROM golang:1.23-alpine AS builder

WORKDIR /app

COPY go.mod ./
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o /forge-git-svc .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates git
COPY --from=builder /forge-git-svc /forge-git-svc

EXPOSE 8081

CMD ["/forge-git-svc"]
