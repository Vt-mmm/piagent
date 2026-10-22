package ratelimit

import "net/http"

// Options configure Middleware (SPEC.md §4).
type Options struct {
	Store      *Keyed
	KeyFunc    func(*http.Request) string
	TrustProxy bool
	Exempt     func(*http.Request) bool
}

// Middleware rate-limits requests per client.
// TODO: not implemented yet (SPEC.md §4); currently lets everything through.
func Middleware(opts Options) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler { return next }
}

// ClientIP returns the client address used as the default key (SPEC.md §5).
// TODO: not implemented yet.
func ClientIP(r *http.Request, trustProxy bool) string { return "" }
