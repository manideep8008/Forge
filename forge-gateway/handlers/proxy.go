package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"forge-gateway/middleware"

	"github.com/rs/zerolog/log"
)

// ProxyHandler returns an http.HandlerFunc that transparently proxies all
// methods to the orchestrator, stripping the /api gateway prefix.
// It injects X-User-ID from the validated JWT claims so downstream services
// can identify the caller without re-parsing the token.
func ProxyHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := middleware.GetUserID(r)

		// Strip the /api gateway prefix — the orchestrator routes have no such prefix.
		orchPath := strings.TrimPrefix(r.URL.Path, "/api")
		target := fmt.Sprintf("%s%s", orchestratorURL, orchPath)
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}

		var resp *http.Response
		var err error

		switch r.Method {
		case http.MethodGet:
			resp, err = proxyGetWithUser(target, r, userID)
		case http.MethodPost:
			resp, err = proxyPostWithUser(target, nil, r, userID)
		case http.MethodPatch:
			resp, err = proxyPostWithUser(target, nil, r, userID) // reuse post helper
		case http.MethodDelete:
			resp, err = proxyDeleteWithUser(target, r, userID)
		default:
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if err != nil {
			log.Error().Err(err).Str("target", target).Msg("orchestrator unreachable")
			jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		relayResponse(w, resp)
	}
}

// proxyGetWithUser is like proxyGet but also sets X-User-ID on the outgoing request.
func proxyGetWithUser(url string, orig *http.Request, userID string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(orig.Context(), http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	propagateHeaders(orig, req)
	req.Header.Set("X-User-ID", userID)
	return httpClient.Do(req)
}

// proxyPostWithUser proxies a POST (or PATCH) forwarding the original body and X-User-ID.
func proxyPostWithUser(url string, body []byte, orig *http.Request, userID string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(orig.Context(), orig.Method, url, orig.Body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	propagateHeaders(orig, req)
	req.Header.Set("X-User-ID", userID)
	return httpClient.Do(req)
}

// proxyDeleteWithUser proxies a DELETE with X-User-ID.
func proxyDeleteWithUser(url string, orig *http.Request, userID string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(orig.Context(), http.MethodDelete, url, nil)
	if err != nil {
		return nil, err
	}
	propagateHeaders(orig, req)
	req.Header.Set("X-User-ID", userID)
	return httpClient.Do(req)
}
