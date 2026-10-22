package ratelimit

import (
	"encoding/json"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// Options configure Middleware (SPEC.md §4).
type Options struct {
	Store      *Keyed
	KeyFunc    func(*http.Request) string
	TrustProxy bool
	Exempt     func(*http.Request) bool
}

// Middleware rate-limits requests per client key.
func Middleware(opts Options) func(http.Handler) http.Handler {
	if opts.Store == nil {
		panic("ratelimit: Options.Store is required")
	}
	keyFunc := opts.KeyFunc
	if keyFunc == nil {
		trust := opts.TrustProxy
		keyFunc = func(r *http.Request) string { return ClientIP(r, trust) }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if opts.Exempt != nil && opts.Exempt(r) {
				next.ServeHTTP(w, r)
				return
			}
			d := opts.Store.Allow(keyFunc(r))
			h := w.Header()
			h.Set("X-RateLimit-Limit", strconv.Itoa(d.Limit))
			h.Set("X-RateLimit-Remaining", strconv.Itoa(d.Remaining))
			if d.Allowed {
				next.ServeHTTP(w, r)
				return
			}
			seconds := int(math.Ceil(d.RetryAfter.Seconds()))
			if seconds < 1 {
				seconds = 1
			}
			h.Set("Retry-After", strconv.Itoa(seconds))
			h.Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "rate_limited", "retry_after": seconds})
		})
	}
}

// ClientIP returns the client address used as the default key (SPEC.md §5).
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			first, _, _ := strings.Cut(forwarded, ",")
			return strings.TrimSpace(first)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
