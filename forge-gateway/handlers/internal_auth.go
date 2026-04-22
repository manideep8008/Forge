package handlers

import (
	"net/http"
	"os"
)

const internalAPIKeyHeader = "X-Internal-API-Key"

func addInternalAuth(req *http.Request) {
	req.Header.Set(internalAPIKeyHeader, os.Getenv("INTERNAL_API_KEY"))
}
